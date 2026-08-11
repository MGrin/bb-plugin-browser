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
  // "run" was never called anywhere in this file even before this round's
  // fix — only browserCdpUrl ever was. Narrowing the Pick to match is a
  // deliberate correction (not just what silences a test fixture's excess-
  // property error), and it also closes the over-declared-deps gap between
  // what this module asks for and what it actually uses.
  engine: Pick<Engine, "browserCdpUrl">;
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
  /**
   * The browser's DevTools HTTP origin (e.g. "http://127.0.0.1:9222") at
   * the moment this page was created. Lets a read-only lookup confirm the
   * browser is alive with a plain HTTP probe instead of going through
   * `engine.browserCdpUrl`, which is launch mode and would start Chromium
   * just to answer the question. Absent on bindings written before this
   * field existed — those are treated as unreachable, never as licence to
   * call `browserCdpUrl` to find out.
   */
  origin?: string;
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
  /**
   * The same read-only lookup as `existingPageUrl`, plus the document URL the
   * page is currently on — what the panel's address bar shows. It comes from
   * the target list this lookup already fetches, so asking costs nothing
   * extra and, like `existingPageUrl`, never creates a page: the panel must
   * be able to say "nothing open here yet" without opening anything.
   */
  existingPageInfo(sessionKey: string): Promise<{ cdpUrl: string; url: string } | null>;
  closePage(sessionKey: string): Promise<void>;
  forget(sessionKey: string): Promise<void>;
}

const key = (sessionKey: string) => `page:${sessionKey}`;

function pageUrl(browserUrl: string, targetId: string): string {
  const base = new URL(browserUrl);
  return `${base.protocol}//${base.host}/devtools/page/${targetId}`;
}

/** The plain-HTTP origin backing a CDP websocket URL, for `/json/version`. */
function httpOriginOf(browserUrl: string): string {
  const base = new URL(browserUrl);
  return `${base.protocol === "wss:" ? "https:" : "http:"}//${base.host}`;
}

// A local process is either already answering or plainly isn't — there is
// no reason to wait anywhere near CDP's normal 30s command timeout to find
// out, and every caller of this (existingPageUrl, closePage) is a read-only
// or best-effort path that must resolve quickly rather than stall a stream
// route or a cleanup on a dead port.
const PROBE_TIMEOUT_MS = 750;

/**
 * The browser's current, live CDP websocket URL, discovered by asking its
 * DevTools HTTP endpoint directly — never by calling `engine.browserCdpUrl`,
 * which is launch mode and would start a browser to answer this. `null`
 * covers every failure uniformly (connection refused, timeout, a stale port
 * now held by something else, a malformed response): none of them are a
 * reason to try harder or fall back to launching.
 */
async function probeBrowserUrl(origin: string): Promise<string | null> {
  try {
    const response = await fetch(`${origin}/json/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    return typeof body.webSocketDebuggerUrl === "string" ? body.webSocketDebuggerUrl : null;
  } catch {
    return null;
  }
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
      const binding: Binding = {
        profile,
        targetId: created.targetId,
        origin: httpOriginOf(browserUrl),
      };
      await deps.kv.set(key(sessionKey), binding);
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

  async function existingPageInfo(
    sessionKey: string,
  ): Promise<{ cdpUrl: string; url: string } | null> {
    const bound = await deps.kv.get<Binding>(key(sessionKey));
    // No origin covers both "never bound" and "bound before this field
    // existed" — either way, there is nothing to probe, so this must
    // report "no page" rather than fall back to a launch-capable lookup.
    if (!bound?.origin) return null;
    const browserUrl = await probeBrowserUrl(bound.origin);
    if (!browserUrl) return null;
    const open = await targets(browserUrl);
    const target = open.find((candidate) => candidate.targetId === bound.targetId);
    if (!target) return null;
    return { cdpUrl: pageUrl(browserUrl, bound.targetId), url: target.url };
  }

  return {
    pageUrlFor,
    existingPageInfo,

    async existingPageUrl(sessionKey) {
      return (await existingPageInfo(sessionKey))?.cdpUrl ?? null;
    },

    async closePage(sessionKey) {
      const bound = await deps.kv.get<Binding>(key(sessionKey));
      if (!bound) return;

      if (!bound.origin) {
        // A pre-origin binding: there is no way to confirm a browser is
        // even there without launching one, and a cold-start cleanup must
        // not do that. Treat as already gone.
        deps.log(`closePage: ${sessionKey} has no recorded origin, clearing binding without probing`);
        await deps.kv.delete(key(sessionKey));
        return;
      }

      const browserUrl = await probeBrowserUrl(bound.origin);
      if (!browserUrl) {
        // Unreachable: the page this binding names cannot exist either, so
        // there is nothing to close through CDP — just drop the binding
        // rather than launching a browser to close a page in it.
        deps.log(`closePage: browser for ${sessionKey} not reachable at ${bound.origin}, clearing binding`);
        await deps.kv.delete(key(sessionKey));
        return;
      }

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
