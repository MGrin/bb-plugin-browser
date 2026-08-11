// The panel's video path: motion JPEG over a plain HTTP response.
//
// An <img> decodes multipart/x-mixed-replace natively, which means no
// websocket, no client-side decoder, and no reconnect logic. Frames are
// dropped rather than queued: a phone on a slow link must never make the
// Mac's view lag or grow this process's memory — and because a cast is
// shared (screencast.ts is refcounted), a backlog for one slow viewer would
// also lag every other viewer on the same session.
//
// `auth: "token"` is deliberate: an <img> sends no Origin header, so
// auth: "local" (which checks Origin/Host) cannot authenticate it, and the
// token in the query string is what lets this load over the Cloudflare
// tunnel from a phone that has no cookie jar shared with the bb app origin.
import type { BbPluginApi } from "@bb/plugin-sdk";
import type { Screencast } from "./screencast.js";

const BOUNDARY = "bbbrowserframe";

export type FrameSource = (
  onFrame: (jpegBase64: string) => void,
) => Promise<() => void>;

export function mjpegResponse(subscribe: FrameSource): Response {
  let unsubscribe: (() => void) | null = null;
  // Set on every termination path — cancel(), an enqueue that throws because
  // the client is already gone, and a cancel that lands while subscribe() is
  // still in flight. Once true, the cast is either already unsubscribed or
  // about to be the moment `unsubscribe` is assigned; no path may double-fire
  // or skip it.
  let stopped = false;

  function stop(): void {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        unsubscribe = await subscribe((jpegBase64) => {
          if (stopped) return;

          // The honest backpressure signal on a default ReadableStream
          // controller is desiredSize: at or below zero means the consumer
          // has not drained what's already queued. `enqueue` itself has no
          // opinion — it accepts chunks regardless of whether anyone is
          // reading, so a "wrote last time" flag (as opposed to this) would
          // let an unbounded backlog build the instant the client can't keep
          // up. A stale frame is worthless to a live view, so the fix here
          // is to drop it, not to buffer it: memory for a slow viewer belongs
          // in that viewer's own pipe, never in this process.
          if (controller.desiredSize !== null && controller.desiredSize <= 0) return;

          const frame = Buffer.from(jpegBase64, "base64");
          try {
            // All three enqueues happen in one synchronous turn under one
            // desiredSize check, so a frame is either written whole or not
            // at all — nothing here can leave a dangling header with no
            // body on the wire.
            controller.enqueue(
              Buffer.from(
                `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
                "binary",
              ),
            );
            controller.enqueue(frame);
            controller.enqueue(Buffer.from("\r\n", "binary"));
          } catch {
            // enqueue throws once the client is gone and the controller has
            // been errored/closed out from under us. Some runtimes never
            // call cancel() for that case, so this is the only signal we
            // get — release the cast's reference right here instead of
            // waiting for a cancel() that may not come.
            stop();
          }
        });
      } catch (error) {
        // subscribe() itself rejected (e.g. the page vanished mid-start).
        // Nothing to unsubscribe from, but the stream must still end.
        stop();
        throw error;
      }

      if (stopped) {
        // The client cancelled while subscribe() was still in flight:
        // `stop()` ran with `unsubscribe` still null and had nothing to
        // call. Finish the job now that it exists, or this cast would sit
        // subscribed — encoding frames for nobody — until some other
        // subscriber happens to unsubscribe it.
        unsubscribe();
      }
    },
    cancel() {
      stop();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "cache-control": "no-store",
      connection: "close",
    },
  });
}

// The path carries no session key: bb's plugin HTTP dispatcher matches a
// registered route path by exact string equality, not by pattern (verified
// against the running host — see task-8-report.md) — a literal
// "/stream/:sessionKey" registration can never match a real request path
// like "/stream/thr_abc123". The first-party `tasks` plugin hits the same
// constraint and works around it the same way: a static path plus the id in
// the query string (its /attachments/download?attachmentId=... route). This
// mirrors that.
export const STREAM_PATH = "/stream";

export function registerStreamRoute(
  bb: BbPluginApi,
  screencast: Screencast,
  profileFor: (sessionKey: string) => Promise<string>,
): void {
  bb.http.route(
    "GET",
    STREAM_PATH,
    async (context) => {
      const sessionKey = context.req.query("sessionKey");
      if (!sessionKey) return new Response("missing sessionKey", { status: 400 });
      const profile = await profileFor(sessionKey);
      return mjpegResponse((onFrame) => screencast.subscribe(sessionKey, profile, onFrame));
    },
    { auth: "token" },
  );
}
