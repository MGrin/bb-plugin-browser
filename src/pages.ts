// One page per session key, remembered across restarts and verified on use.
//
// Remembering matters because a thread that comes back after a bb restart
// should still be on its page. Verifying matters because a page can vanish
// without telling us — the panel's close button, a crash, the idle reaper —
// and a stale id must produce a fresh page rather than an error.
import type { Engine } from "./engine.js";
import { openCdp } from "./cdp.js";

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

export interface PagesDeps {
  engine: Pick<Engine, "browserCdpUrl" | "run">;
  kv: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  log: (message: string) => void;
}

interface Binding {
  profile: string;
  targetId: string;
}

export interface Pages {
  /** The page-level CDP websocket for this session, creating it if needed. */
  pageUrlFor(sessionKey: string, profile: string): Promise<string>;
  /**
   * The bound page's CDP websocket if a binding exists and its target is
   * still open — `null` otherwise. Unlike `pageUrlFor`, a miss here is never
   * a reason to create anything: this exists so a viewer (the stream route)
   * can ask "is there a real page to watch?" without ever being the reason
   * one gets spawned. Read-only: a stale binding is left exactly as found,
   * for `pageUrlFor` to reconcile on the next real use.
   */
  existingPageUrl(sessionKey: string): Promise<string | null>;
  closePage(sessionKey: string): Promise<void>;
  forget(sessionKey: string): Promise<void>;
}

const key = (sessionKey: string) => `page:${sessionKey}`;

function pageUrl(browserUrl: string, targetId: string): string {
  const base = new URL(browserUrl);
  return `${base.protocol}//${base.host}/devtools/page/${targetId}`;
}

export function createPages(deps: PagesDeps): Pages {
  // Every caller of openCdp wraps its use in try/finally so a throw mid-way
  // (a bad send, a JSON parse failure, whatever) still closes the socket —
  // no path here opens a CDP connection without a matching close on both
  // the success and the error branch.
  async function targets(browserUrl: string): Promise<TargetInfo[]> {
    const session = await openCdp(browserUrl);
    try {
      const result = await session.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
      return result.targetInfos.filter((target) => target.type === "page");
    } finally {
      session.close();
    }
  }

  async function resolvePageUrl(sessionKey: string, profile: string): Promise<string> {
    const browserUrl = await deps.engine.browserCdpUrl(profile);
    const bound = await deps.kv.get<Binding>(key(sessionKey));
    const open = await targets(browserUrl);

    if (bound && open.some((target) => target.targetId === bound.targetId)) {
      return pageUrl(browserUrl, bound.targetId);
    }

    const session = await openCdp(browserUrl);
    try {
      const created = await session.send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
      await deps.kv.set(key(sessionKey), { profile, targetId: created.targetId });
      deps.log(`created page ${created.targetId} for ${sessionKey} on ${profile}`);
      return pageUrl(browserUrl, created.targetId);
    } finally {
      session.close();
    }
  }

  // A coordinator and its subagents share one session key by design (see
  // session-key.ts), so concurrent pageUrlFor calls for the same key are
  // the normal fleet case, not an edge case. Without coalescing, two
  // concurrent calls both see no binding, both create a page, and only the
  // last kv.set wins — orphaning the other tab forever and handing the
  // first caller a page id closePage will never know about. One in-flight
  // promise per session key means every concurrent caller gets the same
  // resolution (or the same rejection); the entry is removed once settled
  // so a failure doesn't poison later, unrelated calls.
  const inflight = new Map<string, Promise<string>>();

  function pageUrlFor(sessionKey: string, profile: string): Promise<string> {
    const existing = inflight.get(sessionKey);
    if (existing) return existing;

    const settling = resolvePageUrl(sessionKey, profile).finally(() => {
      inflight.delete(sessionKey);
    });
    inflight.set(sessionKey, settling);
    return settling;
  }

  return {
    pageUrlFor,

    async existingPageUrl(sessionKey) {
      const bound = await deps.kv.get<Binding>(key(sessionKey));
      if (!bound) return null;
      const browserUrl = await deps.engine.browserCdpUrl(bound.profile);
      const open = await targets(browserUrl);
      if (!open.some((target) => target.targetId === bound.targetId)) return null;
      return pageUrl(browserUrl, bound.targetId);
    },

    async closePage(sessionKey) {
      const bound = await deps.kv.get<Binding>(key(sessionKey));
      if (!bound) return;
      const browserUrl = await deps.engine.browserCdpUrl(bound.profile);
      const session = await openCdp(browserUrl);
      try {
        await session.send("Target.closeTarget", { targetId: bound.targetId });
      } catch (error) {
        // Real Chrome errors closing a targetId it no longer has — the
        // panel's close button, a crash, the idle reaper could all have
        // gotten there first. That's not a reason to strand the binding:
        // the page is gone either way, so treat the error as confirmation
        // rather than a failure.
        deps.log(
          `closePage: ${bound.targetId} already gone (${(error as Error).message})`,
        );
      } finally {
        session.close();
      }
      await deps.kv.delete(key(sessionKey));
    },

    async forget(sessionKey) {
      await deps.kv.delete(key(sessionKey));
    },
  };
}
