// Pixels out, input in — the same page the tools drive.
//
// Reference-counted on purpose: a page nobody is watching must cost nothing,
// and a screencast left running would encode frames forever for an audience
// of zero. There is no buffer between "a frame arrived" and "every current
// subscriber saw it": each frame is handed straight to the subscribers set
// and then dropped, so nothing here can accumulate a backlog for a slow
// viewer — that is what a phone on a bad link looks like, and it must cost
// memory in the viewer's own pipe, never in this module.
import { openCdp, type CdpSession } from "./cdp.js";

export type InputEvent =
  | {
      kind: "mouse";
      type: "mousePressed" | "mouseReleased" | "mouseMoved";
      x: number;
      y: number;
      button: "left" | "none";
      clickCount: number;
    }
  | { kind: "key"; type: "keyDown" | "keyUp" | "char"; text?: string; key?: string }
  | { kind: "scroll"; x: number; y: number; deltaY: number };

/** The page's own coordinate space, in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
}

export interface ScreencastDeps {
  quality: number;
  maxWidth: number;
}

export interface Screencast {
  /**
   * Watch a page that ALREADY EXISTS. The caller passes the page's CDP
   * websocket, resolved read-only — this module has no way to resolve one
   * and therefore no way to be the reason a page or a browser gets created.
   * That used to be a TOCTOU pre-check in stream.ts (which checked for a
   * page, then subscribed through a launch-capable lookup); it is now a
   * property of this signature and of what this file imports.
   */
  subscribe(
    sessionKey: string,
    cdpUrl: string,
    onFrame: (jpegBase64: string) => void,
  ): Promise<() => void>;
  /**
   * Send input to the live cast for this session. Rejects when nothing is
   * casting: a click has no page url of its own, and inventing one is how a
   * keystroke aimed at a page that already closed used to mint a blank one.
   */
  dispatchInput(sessionKey: string, event: InputEvent): Promise<void>;
  /**
   * The CSS viewport the latest frame of this session's cast was captured
   * from, or null when nothing is casting (or no frame has arrived yet).
   *
   * The panel needs it to turn a click in its own pixels into a page
   * coordinate: `maxWidth` downscales frames, so on a wide or high-DPI page
   * the decoded frame is smaller than the viewport and a click computed
   * against the frame lands proportionally off. Null doubles as "no live
   * view for this session", which is what makes it safe to drop input
   * instead of letting `dispatchInput` open a page nobody asked for.
   */
  viewportOf(sessionKey: string): Viewport | null;
  stopAll(): void;
}

/**
 * How often a watched tab re-asserts the foreground.
 *
 * Frequent enough that a stolen foreground costs a second of frozen view
 * rather than the rest of the session, cheap enough to be invisible: the call
 * is a no-op when the tab is already in front.
 */
const FOREGROUND_INTERVAL_MS = 1000;

interface Cast {
  session: CdpSession;
  subscribers: Set<(frame: string) => void>;
  /** Last frame's reported viewport; null until the first frame arrives. */
  viewport: Viewport | null;
  /** Keeps this tab in the foreground for as long as anyone is watching. */
  foreground: ReturnType<typeof setInterval> | null;
}

export function createScreencast(deps: ScreencastDeps): Screencast {
  const casts = new Map<string, Cast>();

  // Two panels opening on the same session at once must not race into two
  // Page.startScreencast calls — the loser would strand a CDP session that
  // nothing ever unsubscribes from or closes. One in-flight start per
  // session key, mirroring pages.ts's pageUrlFor coalescing for the same
  // shaped race.
  const starting = new Map<string, Promise<Cast>>();

  function closeCast(cast: Cast): void {
    cast.session.send("Page.stopScreencast").catch(() => {}).finally(() => cast.session.close());
  }

  async function startCast(cdpUrl: string): Promise<Cast> {
    const session = await openCdp(cdpUrl);
    try {
      const cast: Cast = { session, subscribers: new Set(), viewport: null, foreground: null };
      session.on("Page.screencastFrame", (params) => {
        const frame = params as {
          data: string;
          sessionId: number;
          // Chrome's ScreencastFrameMetadata. deviceWidth/deviceHeight are
          // the page's CSS-pixel viewport, independent of how far the frame
          // itself was scaled down to fit `maxWidth`.
          metadata?: { deviceWidth?: number; deviceHeight?: number };
        };
        const width = frame.metadata?.deviceWidth;
        const height = frame.metadata?.deviceHeight;
        // A zero or absent dimension is not a viewport report: it would
        // divide a click by zero downstream, so leave the last good one (or
        // null) in place rather than record it.
        if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
          cast.viewport = { width, height };
        }
        // Chrome won't send the next frame until this one is acked, so the
        // ack must go out regardless of who is or isn't listening. It's
        // fire-and-forget: a rejected ack (socket already on its way down)
        // is not this handler's problem to surface.
        session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
        for (const subscriber of cast.subscribers) {
          try {
            subscriber(frame.data);
          } catch {
            // A subscriber throwing (an HTTP write after the viewer's
            // socket already closed, say) must not take out every other
            // subscriber sharing this cast, and must not become an
            // uncaught exception at the CDP message-handler level, which
            // is process-wide in the plugin host.
          }
        }
      });
      // Chrome does not composite a background tab, and every thread's page
      // is a tab in one shared browser — so without this, a cast on any tab
      // but the active one delivers zero frames forever while still looking
      // healthy (HTTP 200, no error, no pixels). Measured on the real
      // browser during Task 9's live verification.
      //
      // Sent, never awaited. A CDP command that never answers only rejects
      // after cdp.ts's 30s timeout, and awaiting this one would put that
      // wait between the viewer and their first frame — the panel's <img>
      // hanging with no response at all, which is indistinguishable from a
      // broken route. Writes are ordered on the socket, so the browser
      // still sees it before startScreencast; a refusal is ignored, because
      // a page can still repaint on its own.
      //
      // The cost is that two viewers on two threads take turns being the
      // front tab — strictly better than neither of them seeing anything.
      void session.send("Page.bringToFront").catch(() => {});
      await session.send("Page.startScreencast", {
        format: "jpeg",
        quality: deps.quality,
        maxWidth: deps.maxWidth,
      });
      // And keep asking. Once is not enough: a headless tab that loses the
      // foreground stops producing frames ENTIRELY, so the panel freezes
      // while the page underneath goes on working — you type, the keystroke
      // lands, and nothing changes on screen. Anything else opening a tab in
      // this shared browser can take the foreground away, and so can the
      // browser itself. A no-op when the tab is already in front, and it
      // stops with the last viewer, so a page nobody watches costs nothing.
      cast.foreground = setInterval(() => {
        void session.send("Page.bringToFront").catch(() => {});
      }, FOREGROUND_INTERVAL_MS);
      return cast;
    } catch (error) {
      // Failed partway through — nobody else knows this session exists, so
      // this is the only chance to close it.
      session.close();
      throw error;
    }
  }

  function getOrStartCast(sessionKey: string, cdpUrl: string): Promise<Cast> {
    const existing = casts.get(sessionKey);
    if (existing) return Promise.resolve(existing);
    const inflight = starting.get(sessionKey);
    if (inflight) return inflight;

    // Whether this start may write anywhere is decided per entry, by
    // object identity, not by a "has stopAll run since I started" flag: a
    // global marker cannot tell apart two starts that began in the same
    // window (e.g. a fresh start B, and a second start C that should
    // coalesce onto B) — only "am I still the promise currently on record
    // for this key" can, in every ordering, including the one where some
    // *other* stale start's cleanup would otherwise have evicted this
    // entry out from under it.
    const promise: Promise<Cast> = startCast(cdpUrl).then(
      (cast) => {
        if (starting.get(sessionKey) !== promise) {
          // Something else now owns this key — a stopAll cleared this
          // entry (and nothing since put it back), or another caller's
          // start became the recorded one instead. Either way, this cast
          // has no subscribers of its own and must not install itself or
          // touch anyone else's bookkeeping.
          closeCast(cast);
          throw new Error(`screencast: start for ${sessionKey} superseded`);
        }
        starting.delete(sessionKey);
        casts.set(sessionKey, cast);
        return cast;
      },
      (error) => {
        // startCast itself failed before reaching the identity check
        // above — clean up this entry, but only if it's still ours; a
        // later start may already have replaced it (e.g. after a stopAll
        // that raced this failure).
        if (starting.get(sessionKey) === promise) starting.delete(sessionKey);
        throw error;
      },
    );
    starting.set(sessionKey, promise);
    return promise;
  }

  function stopCast(sessionKey: string, cast: Cast): void {
    // A stale unsubscribe (its cast already replaced by a fresh one under
    // the same session key, e.g. after stopAll) must not delete or close
    // someone else's live cast. Only tear down if this is still the cast
    // on record.
    if (casts.get(sessionKey) !== cast) return;
    casts.delete(sessionKey);
    if (cast.foreground) clearInterval(cast.foreground);
    closeCast(cast);
  }

  return {
    async subscribe(sessionKey, cdpUrl, onFrame) {
      const cast = await getOrStartCast(sessionKey, cdpUrl);
      cast.subscribers.add(onFrame);

      // A flag local to this closure, not a re-derived check against the
      // cast map: it makes a repeated call to the *same* unsubscribe
      // idempotent without depending on map state that may have moved on.
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        cast.subscribers.delete(onFrame);
        if (cast.subscribers.size === 0) stopCast(sessionKey, cast);
      };
    },

    // Reads the cast on record, so a stopped or superseded cast reports
    // null exactly like one that never existed.
    viewportOf(sessionKey) {
      return casts.get(sessionKey)?.viewport ?? null;
    },

    async dispatchInput(sessionKey, event) {
      // No fallback that resolves a page: the panel already gates input on
      // `viewportOf`, and the old fallback went through a launch-capable
      // lookup — so a click aimed at a page that had just closed could mint
      // a blank one, or start a browser, from a keystroke.
      const cast = casts.get(sessionKey);
      if (!cast) throw new Error(`nothing is casting for ${sessionKey}`);
      // The cast's own session, never a throwaway of our own: its lifecycle
      // belongs to subscribe/stopCast, and borrowing it must leave that
      // untouched.
      const session = cast.session;
      if (event.kind === "mouse") {
        await session.send("Input.dispatchMouseEvent", {
          type: event.type,
          x: event.x,
          y: event.y,
          button: event.button,
          clickCount: event.clickCount,
        });
      } else if (event.kind === "key") {
        await session.send("Input.dispatchKeyEvent", {
          type: event.type,
          text: event.text,
          key: event.key,
        });
      } else {
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: event.x,
          y: event.y,
          deltaX: 0,
          deltaY: event.deltaY,
          button: "none",
          clickCount: 0,
        });
      }
    },

    stopAll() {
      // Closing every live cast is straightforward — this is the only
      // owner of those sessions. Clearing `starting` (rather than leaving
      // in-flight entries in place) is what makes each one's own identity
      // check above come back mismatched once it resolves: nothing here
      // currently equals a promise that was cleared out from under it.
      for (const cast of casts.values()) cast.session.close();
      casts.clear();
      starting.clear();
    },
  };
}
