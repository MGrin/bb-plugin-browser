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
import type { PageRegistry } from "./page-registry.js";
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
  // consumes the default one-chunk high-water mark, and the first frame —
  // which on a static page is the only frame there will ever be — would then
  // be the one left waiting.
  let firstFrame = true;

  // The newest frame not yet handed to the consumer. At most one: a live view
  // wants the latest picture, never a queue of stale ones.
  let pending: Buffer | null = null;

  function stop(): void {
    if (stopped) return;
    stopped = true;
    unsub();
  }

  /**
   * Hand the newest frame over if the consumer has room for it.
   *
   * Called both when a frame arrives and from the stream's own `pull`, which
   * is what makes this safe on a page that goes quiet. The previous version
   * DISCARDED any frame arriving while `desiredSize <= 0` — and a default
   * one-chunk high-water mark is in exactly that state the instant after any
   * frame is enqueued. On a continuously repainting page that is merely
   * lossy. On a page that repaints once and settles it is fatal: click a
   * button, the post-click repaint arrives while the consumer has not pulled,
   * it is thrown away, the page then goes still and emits nothing further —
   * and the view sits on a pre-click image forever while the stream, the cast
   * and the page are all perfectly healthy. That is the "it froze completely"
   * this fixes.
   *
   * Holding one frame instead of discarding it keeps the memory bound the
   * same (one frame, never a backlog, so a slow phone still cannot lag the
   * Mac or the other viewers sharing this cast) while making starvation
   * impossible.
   */
  function flush(): void {
    const controller = controllerRef;
    if (!controller || stopped || !pending) return;
    if (controller.desiredSize !== null && controller.desiredSize <= 0) return;

    const frame = pending;
    pending = null;
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
  }

  try {
    unsub = await subscribe((jpegBase64) => {
      if (stopped) return;
      // Newest wins: an older frame nobody has taken yet is worthless.
      pending = Buffer.from(jpegBase64, "base64");
      flush();
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
    // The other half of latest-frame-wins: when the consumer drains, hand it
    // whatever the newest frame is. Without this, a frame that arrived while
    // the queue was full would sit unsent until the page happened to repaint
    // again — which on a settled page is never.
    pull() {
      flush();
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

export interface StreamRouteDeps {
  screencast: Pick<Screencast, "subscribe">;
  /**
   * The READ-ONLY page registry, not `Pages`. page-registry.ts has no
   * access to `engine`, so nothing this route can reach is able to create a
   * page or start a browser — the invariant is the import graph's now, not
   * a comment's. It used to be a pre-check here followed by a subscribe
   * that resolved through the launch-capable path anyway, which was a
   * TOCTOU gap as well as a lie.
   */
  pages: Pick<PageRegistry, "existingPageUrl">;
  resolveSessionKey: SessionKeyResolver;
  /**
   * A viewer counts as using the page. Someone watching the panel is using
   * it even when no command has run for an hour, so the idle reaper must not
   * close it under them — this is the refcount that says so, and it is a
   * required dependency because a route that quietly forgot to take it would
   * blank a live viewer's screen with nothing to point at.
   */
  viewers: { watch(sessionKey: string): void; unwatch(sessionKey: string): void };
}

export function registerStreamRoute(bb: BbPluginApi, deps: StreamRouteDeps): void {
  const { screencast, pages, resolveSessionKey, viewers } = deps;
  bb.http.route(
    "GET",
    STREAM_PATH,
    async (context) => {
      // A thread id, and only a thread id. The session key is DERIVED from
      // it here (session-key.ts walks the thread's ancestry), never read
      // from the request, so no caller can name a session key directly:
      // not one belonging to a thread that does not exist, not one outside
      // the thread graph, and not one smuggled past the derivation.
      //
      // What this is NOT is an authorization boundary, and the comment that
      // used to sit here implied it was. This route's auth is bb's
      // per-plugin token, which carries no caller identity — so any local
      // process holding that token can name any thread id and watch that
      // thread's page. That is defence in depth rather than a privilege
      // boundary: every thread on this machine already has a shell, and a
      // shell can read the same profile directly. The value of deriving the
      // key is that it removes a whole class of parameter-tampering bugs,
      // not that it keeps one thread out of another's browser.
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

      return mjpegResponse(async (onFrame) => {
        // The url this route already resolved, handed straight over. The
        // screencast has no way to resolve one for itself, so "watching
        // never creates a page" holds even in the window between the check
        // above and the subscribe: the worst case is a connect that fails.
        const unsubscribe = await screencast.subscribe(sessionKey, existing, onFrame);
        // Counted only once the subscribe has actually succeeded, so a
        // failed one cannot leave a phantom viewer holding a page open for
        // the life of the plugin. Released exactly once: mjpegResponse can
        // reach its teardown from either a client cancel or a write failure,
        // and both may observe the same dead connection.
        viewers.watch(sessionKey);
        let released = false;
        return () => {
          unsubscribe();
          if (released) return;
          released = true;
          viewers.unwatch(sessionKey);
        };
      });
    },
    { auth: "token" },
  );
}
