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
import type { Pages } from "./pages.js";
import type { Screencast } from "./screencast.js";
import type { SessionKeyResolver } from "./session-key.js";

const BOUNDARY = "bbbrowserframe";

export type FrameSource = (
  onFrame: (jpegBase64: string) => void,
) => Promise<() => void>;

// `subscribe` is resolved to completion before any Response is constructed
// (review finding 6): a subscribe that rejects — the page vanished in the
// narrow gap between the route's existence check and here, say — must
// produce a real error status and a readable body, not an <img> stuck on a
// 200 whose multipart body immediately errors out with no diagnostic. This
// also means a client can never cancel while subscribe() is still pending:
// there is no Response, and therefore no reader, until subscribe already
// settled.
export async function mjpegResponse(subscribe: FrameSource): Promise<Response> {
  // Bridges subscribe()'s onFrame (armed immediately) to the
  // ReadableStream's controller (which cannot exist until subscribe has
  // already resolved). The two are guaranteed to line up before any frame
  // this module's own onFrame is ever handed can arrive: nothing here
  // awaits between `unsub = await subscribe(...)` resolving and `start()`
  // running synchronously inside `new ReadableStream(...)` just below it.
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  // Guards `unsub()` against firing twice as independent termination
  // signals race each other (a client cancel and a write failure can both
  // observe the same dead connection).
  let stopped = false;
  let unsub: () => void = () => {};

  // The opening boundary rides along with the first frame rather than being
  // enqueued when the stream starts: an enqueue before anyone has read
  // consumes the default one-chunk high-water mark, and the desiredSize
  // guard below would then drop the very first frame — which on a static
  // page is the only frame there will ever be.
  let firstFrame = true;

  function stop(): void {
    if (stopped) return;
    stopped = true;
    unsub();
  }

  try {
    unsub = await subscribe((jpegBase64) => {
      const controller = controllerRef;
      if (!controller || stopped) return;

      // The honest backpressure signal on a default ReadableStream
      // controller is desiredSize: at or below zero means the consumer
      // has not drained what's already queued. `enqueue` itself has no
      // opinion — it accepts chunks regardless of whether anyone is
      // reading, so a "wrote last time" flag would let an unbounded
      // backlog build the instant the client can't keep up. A stale frame
      // is worthless to a live view, so the fix here is to drop it, not
      // buffer it: memory for a slow viewer belongs in that viewer's own
      // pipe, never in this process, and never at the expense of every
      // other viewer sharing this session's cast.
      if (controller.desiredSize !== null && controller.desiredSize <= 0) return;

      const frame = Buffer.from(jpegBase64, "base64");
      try {
        // One enqueue per frame: header, body, and the boundary that CLOSES
        // this part, all written together so a frame is either on the wire
        // whole or not at all — nothing here can leave a dangling header
        // with no body.
        //
        // The trailing boundary is what makes a single frame visible. A
        // browser's multipart parser paints a part when it sees the next
        // boundary, not when Content-Length bytes arrive, and a page that
        // renders once and then holds still produces exactly one frame — so
        // writing the boundary only ahead of the *next* frame leaves an
        // <img> blank forever on a static page while the stream looks
        // healthy. Writing it after each frame instead costs 18 bytes.
        const opening = firstFrame ? `--${BOUNDARY}\r\n` : "";
        firstFrame = false;
        controller.enqueue(
          Buffer.concat([
            Buffer.from(
              `${opening}Content-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
              "binary",
            ),
            frame,
            Buffer.from(`\r\n--${BOUNDARY}\r\n`, "binary"),
          ]),
        );
      } catch {
        // enqueue throws once the client is gone and the controller has
        // been errored/closed out from under us by something other than
        // our own cancel() below (some runtimes never call cancel() for
        // that case — a dropped socket mid-write surfaces only here).
        // Release the cast's reference right here instead of waiting for a
        // cancel() that may not come.
        stop();
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`stream unavailable: ${message}`, {
      status: 502,
      headers: { "content-type": "text/plain" },
    });
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
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
// against the running host's dispatcher source — see task-8-report.md) — a
// literal "/stream/:sessionKey" registration can never match a real request
// path like "/stream/thr_abc123". The first-party `tasks` plugin hits the
// same constraint and works around it the same way: a static path plus the
// id in the query string (its /attachments/download?attachmentId=... route).
// This mirrors that.
export const STREAM_PATH = "/stream";

export function registerStreamRoute(
  bb: BbPluginApi,
  screencast: Screencast,
  pages: Pick<Pages, "existingPageUrl">,
  resolveSessionKey: SessionKeyResolver,
  profileFor: (sessionKey: string) => Promise<string>,
): void {
  bb.http.route(
    "GET",
    STREAM_PATH,
    async (context) => {
      // A thread id, never a session key: session keys are derived
      // server-side (docs/design.md, "Session keys are derived server-side
      // from the calling thread, never accepted as a parameter") — a caller
      // that could hand us an arbitrary session key could spawn or attach
      // to a page it has no business watching.
      const threadId = context.req.query("threadId");
      if (!threadId) return new Response("missing threadId", { status: 400 });

      const sessionKey = await resolveSessionKey(threadId);

      // Never creates. A thread with no page open yet — or whose page
      // already closed — gets a 404, not a freshly minted about:blank tab
      // nobody asked for: watching must never be the reason a page exists.
      const existing = await pages.existingPageUrl(sessionKey);
      if (!existing) {
        return new Response("no page open for this thread", { status: 404 });
      }

      const profile = await profileFor(sessionKey);
      return mjpegResponse((onFrame) => screencast.subscribe(sessionKey, profile, onFrame));
    },
    { auth: "token" },
  );
}
