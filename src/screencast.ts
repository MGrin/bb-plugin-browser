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
import type { Pages } from "./pages.js";

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

export interface ScreencastDeps {
  pages: Pages;
  quality: number;
  maxWidth: number;
}

export interface Screencast {
  subscribe(
    sessionKey: string,
    profile: string,
    onFrame: (jpegBase64: string) => void,
  ): Promise<() => void>;
  dispatchInput(sessionKey: string, profile: string, event: InputEvent): Promise<void>;
  stopAll(): void;
}

interface Cast {
  session: CdpSession;
  subscribers: Set<(frame: string) => void>;
}

export function createScreencast(deps: ScreencastDeps): Screencast {
  const casts = new Map<string, Cast>();

  // Two panels opening on the same session at once must not race into two
  // Page.startScreencast calls — the loser would strand a CDP session that
  // nothing ever unsubscribes from or closes. One in-flight start per
  // session key, mirroring pages.ts's pageUrlFor coalescing for the same
  // shaped race.
  const starting = new Map<string, Promise<Cast>>();

  // Bumped by stopAll so a start already in flight at shutdown time can
  // tell, once it finishes, that it lost the race. Without this, a start
  // that began just before stopAll either (a) finishes after stopAll and
  // sits there encoding frames for an audience of zero — exactly what the
  // header comment forbids — or worse, (b) finishes after a *fresh* cast
  // for the same session key was already started post-shutdown, and its
  // late `casts.set` silently clobbers that fresh cast's map entry, orphaning
  // its session where stopCast's identity guard can never reach it again.
  let epoch = 0;

  async function startCast(sessionKey: string, profile: string): Promise<Cast> {
    const url = await deps.pages.pageUrlFor(sessionKey, profile);
    const session = await openCdp(url);
    try {
      const cast: Cast = { session, subscribers: new Set() };
      session.on("Page.screencastFrame", (params) => {
        const frame = params as { data: string; sessionId: number };
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
      await session.send("Page.startScreencast", {
        format: "jpeg",
        quality: deps.quality,
        maxWidth: deps.maxWidth,
      });
      return cast;
    } catch (error) {
      // Failed partway through — nobody else knows this session exists, so
      // this is the only chance to close it.
      session.close();
      throw error;
    }
  }

  function getOrStartCast(sessionKey: string, profile: string): Promise<Cast> {
    const existing = casts.get(sessionKey);
    if (existing) return Promise.resolve(existing);
    const inflight = starting.get(sessionKey);
    if (inflight) return inflight;

    const startEpoch = epoch;
    const promise: Promise<Cast> = startCast(sessionKey, profile)
      .then((cast) => {
        if (epoch !== startEpoch) {
          // stopAll ran while this was connecting. There is no caller left
          // waiting on this specific cast as "the" cast for this key —
          // close it rather than let it run unwatched, or clobber whatever
          // a later, faster start already installed after the stop.
          cast.session.send("Page.stopScreencast").catch(() => {}).finally(() => cast.session.close());
          throw new Error(`screencast: start for ${sessionKey} superseded by stopAll`);
        }
        casts.set(sessionKey, cast);
        return cast;
      })
      .finally(() => starting.delete(sessionKey));
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
    cast.session.send("Page.stopScreencast").catch(() => {}).finally(() => cast.session.close());
  }

  return {
    async subscribe(sessionKey, profile, onFrame) {
      const cast = await getOrStartCast(sessionKey, profile);
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

    async dispatchInput(sessionKey, profile, event) {
      const cast = casts.get(sessionKey);
      const session = cast ? cast.session : await openCdp(await deps.pages.pageUrlFor(sessionKey, profile));
      try {
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
      } finally {
        // Only a throwaway session gets closed here — a live cast's session
        // is owned by subscribe/stopCast, and dispatchInput borrowing it
        // must leave its lifecycle untouched.
        if (!cast) session.close();
      }
    },

    stopAll() {
      epoch += 1;
      for (const cast of casts.values()) cast.session.close();
      casts.clear();
      starting.clear();
    },
  };
}
