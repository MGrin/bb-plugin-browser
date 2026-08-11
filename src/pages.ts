// One page per session key, remembered across restarts and verified on use.
//
// Remembering matters because a thread that comes back after a bb restart
// should still be on its page. Verifying matters because a page can vanish
// without telling us — the panel's close button, a crash, the idle reaper —
// and a stale id must produce a fresh page rather than an error.
//
// A binding carries two handles to the same tab, because the two halves of
// this plugin address it differently and neither handle works for both:
//
//   targetId — what CDP needs. The screencast opens
//              ws://host/devtools/page/<targetId> to stream the page.
//   tab      — the agent-browser tab LABEL the page was created under, which
//              is what a command session needs. agent-browser's `connect`
//              ignores the /devtools/page/<id> path entirely (measured, 0.33.2),
//              so the only way to point a session at a specific tab is to
//              select it by ref, and a label is the one ref that fails loudly
//              instead of silently resolving to somebody else's tab.
import { randomUUID } from "node:crypto";
import type { Engine } from "./engine.js";
import {
  closeTarget,
  httpOriginOf,
  listPageTargets,
  pageUrl,
  probeBrowserUrl,
} from "./browser-endpoint.js";

export interface PagesDeps {
  /**
   * `run` is here because a page has to be created BY the session that will
   * drive it: labels are session-local (measured — session B cannot see, or
   * select by, a label session A assigned), and `tab new --label` is the
   * only command that assigns one.
   */
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
  /**
   * The tab label this page was created under. Absent on bindings written
   * before Task 9b, whose tab carries no label in any session and therefore
   * cannot be pointed at — such a page is closed and replaced on first use.
   */
  tab?: string;
}

/** What a session needs to put itself on this thread's page. */
export interface PageBinding {
  /** The page-level CDP websocket, for the screencast. */
  cdpUrl: string;
  /** The browser-level CDP websocket, for `agent-browser connect`. */
  browserWsUrl: string;
  /** The tab label, for `agent-browser tab <label>`. */
  tab: string;
}

export interface Pages {
  /** The page-level CDP websocket for this session, creating it if needed. */
  pageUrlFor(sessionKey: string, profile: string): Promise<string>;
  /** Everything a command session needs to bind, creating the page if needed. */
  bindingFor(sessionKey: string, profile: string): Promise<PageBinding>;
  /**
   * Throw away this session's page and give it a fresh, freshly labelled
   * one — recovery for the session's daemon having died, which loses its
   * labels while the tab it drove stays open. Nothing can re-label an
   * existing tab (agent-browser assigns labels only at `tab new`), so
   * recovery means replacing the page and closing the old tab.
   */
  rebind(sessionKey: string, profile: string): Promise<PageBinding>;
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
   * The same read-only lookup, plus the document URL the page is on — what
   * the panel's address bar shows. It comes from the target list the lookup
   * already fetches, so it costs nothing extra and creates nothing either.
   */
  existingPageInfo(sessionKey: string): Promise<{ cdpUrl: string; url: string } | null>;
  closePage(sessionKey: string): Promise<void>;
  forget(sessionKey: string): Promise<void>;
}

const key = (sessionKey: string) => `page:${sessionKey}`;

/**
 * The label every thread's page is created under. One constant, not a
 * per-thread name: a session drives exactly one page, and labels are scoped
 * to the session that assigned them, so there is nothing for a thread-shaped
 * label to disambiguate.
 */
export const TAB_LABEL = "bbpage";

/**
 * A fresh tab is created at `about:blank#<marker>` purely so the target it
 * became can be picked out of the browser's target list by URL: `tab new`
 * reports no CDP target id. Chrome keeps the fragment verbatim (measured),
 * and nothing can collide with a random one — whereas diffing the target
 * list before and after breaks the moment a page opens a popup.
 */
const markerUrl = () => `about:blank#bb-${randomUUID().slice(0, 8)}`;
const isMarker = (url: string) => /^about:blank#bb-[0-9a-f]{8}$/.test(url);

export function createPages(deps: PagesDeps): Pages {
  async function createPage(
    sessionKey: string,
    profile: string,
    browserWsUrl: string,
  ): Promise<PageBinding> {
    const marker = markerUrl();
    const made = await deps.engine.run({
      profile,
      session: sessionKey,
      attach: true,
      argv: ["batch", "--bail"],
      stdin: JSON.stringify([
        ["connect", browserWsUrl],
        ["tab", "new", "--label", TAB_LABEL, marker],
      ]),
    });
    if (made.code !== 0) {
      throw new Error(`could not open a page for this thread: ${made.stderr.trim()}`);
    }

    const open = await listPageTargets(browserWsUrl);
    const created = open.find((target) => target.url === marker);
    if (!created) {
      throw new Error("opened a page for this thread but could not find it in the browser");
    }

    const binding: Binding = {
      profile,
      targetId: created.targetId,
      origin: httpOriginOf(browserWsUrl),
      tab: TAB_LABEL,
    };
    await deps.kv.set(key(sessionKey), binding);
    deps.log(`created page ${created.targetId} for ${sessionKey} on ${profile}`);
    return { cdpUrl: pageUrl(browserWsUrl, created.targetId), browserWsUrl, tab: TAB_LABEL };
  }

  async function resolveBinding(
    sessionKey: string,
    profile: string,
    replace: boolean,
  ): Promise<PageBinding> {
    const browserWsUrl = await deps.engine.browserCdpUrl(profile);
    const bound = await deps.kv.get<Binding>(key(sessionKey));
    const open = await listPageTargets(browserWsUrl);
    const stillOpen = bound && open.some((target) => target.targetId === bound.targetId);

    // A binding with no `tab` predates Task 9b: its tab carries no label in
    // any session, so no session can be pointed at it. Replace it rather
    // than hand back a page the command path cannot reach.
    if (!replace && bound?.tab && stillOpen) {
      return { cdpUrl: pageUrl(browserWsUrl, bound.targetId), browserWsUrl, tab: bound.tab };
    }
    if (bound && stillOpen) {
      // Don't leave the page we're walking away from open forever.
      await closeTarget(browserWsUrl, bound.targetId).catch(() => {});
    }
    return createPage(sessionKey, profile, browserWsUrl);
  }

  // A coordinator and its subagents share one session key by design (see
  // session-key.ts), so concurrent calls for the same key are the normal
  // fleet case. Without coalescing, both see no binding, both create a page,
  // and only the last kv.set wins — orphaning a tab forever and handing the
  // first caller a page id closePage will never know about. One in-flight
  // promise per key, dropped once settled so a failure doesn't poison later
  // calls.
  const inflight = new Map<string, Promise<PageBinding>>();

  function bindingFor(sessionKey: string, profile: string, replace = false): Promise<PageBinding> {
    const existing = inflight.get(sessionKey);
    if (existing && !replace) return existing;

    const settling = resolveBinding(sessionKey, profile, replace).finally(() => {
      if (inflight.get(sessionKey) === settling) inflight.delete(sessionKey);
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
    const open = await listPageTargets(browserUrl);
    const target = open.find((candidate) => candidate.targetId === bound.targetId);
    if (!target) return null;
    // The marker fragment is an implementation detail of how this page was
    // found; showing it in the panel's address bar would be a lie about
    // where the page is.
    const url = isMarker(target.url) ? "about:blank" : target.url;
    return { cdpUrl: pageUrl(browserUrl, bound.targetId), url };
  }

  return {
    bindingFor: (sessionKey, profile) => bindingFor(sessionKey, profile),
    rebind: (sessionKey, profile) => bindingFor(sessionKey, profile, true),
    existingPageInfo,

    async pageUrlFor(sessionKey, profile) {
      return (await bindingFor(sessionKey, profile)).cdpUrl;
    },

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

      // Real Chrome errors closing a targetId it no longer has (the panel's
      // close button, a crash, the reaper). The page is gone either way, so
      // that is confirmation, not a reason to strand the binding.
      await closeTarget(browserUrl, bound.targetId).catch((error: Error) => {
        deps.log(`closePage: ${bound.targetId} already gone (${error.message})`);
      });
      await deps.kv.delete(key(sessionKey));
    },

    async forget(sessionKey) {
      await deps.kv.delete(key(sessionKey));
    },
  };
}
