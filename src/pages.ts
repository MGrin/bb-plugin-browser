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
    /** Every stored key, for the reaper's "who owns which tab" question. */
    list(prefix?: string): Promise<string[]>;
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

/** One open page in the shared browser, and who (if anyone) owns it. */
export interface OpenPage {
  targetId: string;
  /** The document url, with the internal creation marker hidden. */
  url: string;
  /** The session key whose binding names this target, or null for nobody's. */
  sessionKey: string | null;
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
  /**
   * Every open page in the shared browser, each carrying the session key
   * bound to it. What the reaper sweeps: a page with no session key is one
   * nobody owns — a tab Chromium restored on relaunch, or one left behind by
   * a create that died before its binding was written.
   *
   * Read-only and never launch-capable: an empty list means "no browser is
   * reachable", never "start one and look again". The sweep runs every
   * minute forever, so a launch here would hold a Chromium open on an idle
   * machine for good.
   */
  listOpenPages(): Promise<OpenPage[]>;
  /**
   * Close one page by target id, for pages no binding names. Refuses if a
   * binding turns out to name it after all — that is the window between a
   * sweep's listing and its close, and closing there would take a live
   * thread's page away. Rejects when the close itself fails, so a tab that
   * survived is visible rather than assumed gone.
   */
  closeUnboundPage(targetId: string): Promise<void>;
  closePage(sessionKey: string): Promise<void>;
  forget(sessionKey: string): Promise<void>;
}

const key = (sessionKey: string) => `page:${sessionKey}`;
/**
 * Where a profile's browser was last reachable, remembered independently of
 * any one binding. Without it, a browser holding nothing but leftover tabs —
 * every binding gone with the restart that left them — could not be found at
 * all, and the debris would be unreachable forever.
 */
const originKey = (profile: string) => `origin:${profile}`;

/**
 * bb's `kv.list` returns full keys; this tolerates either form so a host that
 * ever returned them stripped could not silently turn every binding lookup
 * into a miss (which would read as "nobody owns any tab" — and reap them all).
 */
const withoutPrefix = (prefix: string, storedKey: string) =>
  storedKey.startsWith(prefix) ? storedKey.slice(prefix.length) : storedKey;

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
    // Labels are unique within a session: a second `tab new --label bbpage`
    // is refused outright ("Label `bbpage` is already used by another tab").
    // Anything that leaves the session holding the label while this plugin
    // thinks it has no page — a CDP close that failed, a reaper calling
    // forget(), a throw after a successful tab new — would wedge the thread
    // out of ever binding again, and only killing its daemon would clear it.
    // So creating starts by reconciling with what the SESSION holds, not
    // with what the binding claims.
    //
    // Deliberately NOT --bail: `tab close` fails whenever there is nothing
    // to reconcile, which is the ordinary case, and measured behaviour is
    // that the batch runs on and creates the tab while still exiting
    // non-zero. The exit code therefore cannot be the verdict here — the
    // marker either turned up in the browser or it did not.
    const made = await deps.engine.run({
      profile,
      session: sessionKey,
      attach: true,
      argv: ["batch"],
      stdin: JSON.stringify([
        ["connect", browserWsUrl],
        ["tab", "close", TAB_LABEL],
        ["tab", "new", "--label", TAB_LABEL, marker],
      ]),
    });

    const open = await listPageTargets(browserWsUrl);
    const created = open.find((target) => target.url === marker);
    if (!created) {
      throw new Error(
        `could not open a page for this thread: ${made.stderr.trim() || "no reason given"}`,
      );
    }

    const binding: Binding = {
      profile,
      targetId: created.targetId,
      origin: httpOriginOf(browserWsUrl),
      tab: TAB_LABEL,
    };
    await deps.kv.set(key(sessionKey), binding);
    // Remembered per profile as well as per binding: the reaper has to be
    // able to find this browser after every binding for it is gone, which is
    // exactly the state a restart leaves behind together with the tabs it
    // restored.
    await deps.kv.set(originKey(profile), binding.origin);
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
      // Don't leave the page we're walking away from open forever. A
      // failure here is logged, never swallowed: it means a labelled tab may
      // still be alive, which createPage's reconcile step then has to clear.
      await closeTarget(browserWsUrl, bound.targetId).catch((error: Error) => {
        deps.log(`could not close ${bound.targetId} for ${sessionKey}: ${error.message}`);
      });
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
  // Rebinds coalesce too, in their own map. Their own, because a rebind must
  // never join an in-flight ordinary resolve — that one may hand back the
  // very page the rebind exists to replace. And coalesced, because two
  // concurrent rebinds for one key would otherwise race to `tab new` the
  // same label, and the loser does not get "a labelled page of its own": it
  // gets a hard "already used by another tab" and the command fails.
  const rebinding = new Map<string, Promise<PageBinding>>();

  function start(
    map: Map<string, Promise<PageBinding>>,
    sessionKey: string,
    profile: string,
    replace: boolean,
  ): Promise<PageBinding> {
    const settling = resolveBinding(sessionKey, profile, replace).finally(() => {
      if (map.get(sessionKey) === settling) map.delete(sessionKey);
    });
    map.set(sessionKey, settling);
    return settling;
  }

  function bindingFor(sessionKey: string, profile: string): Promise<PageBinding> {
    // A rebind in flight is the newer answer, so join it rather than racing.
    return (
      rebinding.get(sessionKey) ??
      inflight.get(sessionKey) ??
      start(inflight, sessionKey, profile, false)
    );
  }

  function rebind(sessionKey: string, profile: string): Promise<PageBinding> {
    return rebinding.get(sessionKey) ?? start(rebinding, sessionKey, profile, true);
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

  /** Every binding on disk, with the session key that owns it. */
  async function allBindings(): Promise<{ sessionKey: string; binding: Binding }[]> {
    const stored = await deps.kv.list("page:");
    const bindings: { sessionKey: string; binding: Binding }[] = [];
    for (const storedKey of stored) {
      const sessionKey = withoutPrefix("page:", storedKey);
      const binding = await deps.kv.get<Binding>(key(sessionKey));
      // A row under some other prefix (a host whose `list` ignores it) reads
      // back as undefined here and is simply not a binding.
      if (binding?.targetId) bindings.push({ sessionKey, binding });
    }
    return bindings;
  }

  /**
   * A live browser's CDP websocket, found by probing origins we have already
   * seen — never by `engine.browserCdpUrl`, which is launch mode. `null`
   * means "no browser is reachable", which is a complete answer.
   */
  async function reachableBrowser(
    bindings: { binding: Binding }[],
  ): Promise<string | null> {
    const origins: string[] = [];
    for (const storedKey of await deps.kv.list("origin:")) {
      const profile = withoutPrefix("origin:", storedKey);
      const origin = await deps.kv.get<string>(originKey(profile));
      if (typeof origin === "string") origins.push(origin);
    }
    for (const { binding } of bindings) if (binding.origin) origins.push(binding.origin);

    for (const origin of new Set(origins)) {
      const browserUrl = await probeBrowserUrl(origin);
      if (browserUrl) return browserUrl;
    }
    return null;
  }

  return {
    bindingFor,
    rebind,
    existingPageInfo,

    async listOpenPages() {
      const bindings = await allBindings();
      const browserUrl = await reachableBrowser(bindings);
      if (!browserUrl) return [];
      const owner = new Map(bindings.map(({ sessionKey, binding }) => [binding.targetId, sessionKey]));
      return (await listPageTargets(browserUrl)).map((target) => ({
        targetId: target.targetId,
        // Same hidden marker as existingPageInfo: what gets logged when a
        // page is reaped should be where the page is, not how it was found.
        url: isMarker(target.url) ? "about:blank" : target.url,
        sessionKey: owner.get(target.targetId) ?? null,
      }));
    },

    async closeUnboundPage(targetId) {
      const bindings = await allBindings();
      // Re-read rather than trusting the caller's snapshot: a binding written
      // since it was taken is a live thread's page, and closing it would take
      // that page away and leave the binding pointing at nothing.
      const owner = bindings.find(({ binding }) => binding.targetId === targetId);
      if (owner) {
        throw new Error(`refusing to close ${targetId}: ${owner.sessionKey} is bound to it`);
      }
      const browserUrl = await reachableBrowser(bindings);
      // No browser, no page: there is nothing to close and nothing to report.
      if (!browserUrl) return;
      await closeTarget(browserUrl, targetId);
    },

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
