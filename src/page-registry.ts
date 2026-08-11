// What is already there — and nothing that could make it so.
//
// This is the read-only half of the page bookkeeping: which target a thread
// is bound to, which pages a browser has open, and closing pages that are
// already nobody's. Its whole point is a dependency it does NOT have. It
// cannot see `engine`, so nothing reachable from here can launch a browser
// or create a page, and the two invariants earlier rounds fought for —
//
//   * watching must never be the reason a page exists;
//   * the reaper must never be the reason a browser process starts;
//
// are now properties of the import graph rather than of a comment somebody
// has to keep obeying. The stream route, the panel's read path, the
// screencast and the reaper all depend on this module; only pages.ts, which
// creates and binds, holds `engine`.
//
// A binding carries two handles to the same tab, because the two halves of
// this plugin address it differently and neither handle works for both:
//
//   targetId — what CDP needs. The screencast opens
//              ws://host/devtools/page/<targetId> to stream the page.
//   tab      — the agent-browser tab LABEL the page was created under, which
//              is what a command session needs. agent-browser's `connect`
//              ignores the /devtools/page/<id> path entirely (measured,
//              0.33.2), so the only way to point a session at a specific tab
//              is to select it by ref, and a label is the one ref that fails
//              loudly instead of silently resolving to somebody else's tab.
import { randomUUID } from "node:crypto";
import type { CdpOptions } from "./cdp.js";
import {
  browserIdOf,
  closeTarget,
  listPageTargets,
  pageUrl,
  probeBrowserUrl,
} from "./browser-endpoint.js";

/** The kv surface a read-only registry needs: no `set`. */
export interface RegistryKv {
  get<T>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<void>;
  /** Every stored key, for the reaper's "who owns which tab" question. */
  list(prefix?: string): Promise<string[]>;
}

export interface PageRegistryDeps {
  kv: RegistryKv;
  log: (message: string) => void;
  /**
   * CDP client tuning — in practice only the connect timeout, and in
   * practice only ever set by a test, since production takes the defaults.
   * It exists because the composed consequence of a connect that hangs
   * cannot be tested at all without a way to make one give up sooner than
   * the production timeout.
   */
  cdp?: CdpOptions;
}

export interface Binding {
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

/**
 * Where a profile's browser was, and WHICH browser it was. The address alone
 * is not a handle on anything: ports are ephemeral and get reused by
 * unrelated processes, so the uuid is what makes going back to it safe.
 */
export interface BrowserPointer {
  origin: string;
  browserId: string;
}

/** One open page in the shared browser, and who (if anyone) owns it. */
export interface OpenPage {
  targetId: string;
  /** The document url, with the internal creation marker hidden. */
  url: string;
  /** The session key whose binding names this target, or null for nobody's. */
  sessionKey: string | null;
}

export const bindingKey = (sessionKey: string) => `page:${sessionKey}`;
/**
 * Where a profile's browser was last reachable, remembered independently of
 * any one binding. Without it, a browser holding nothing but leftover tabs —
 * every binding gone with the restart that left them — could not be found at
 * all, and the debris would be unreachable forever.
 */
export const originKey = (profile: string) => `origin:${profile}`;

/**
 * bb's `kv.list` returns full keys; this tolerates either form so a host that
 * ever returned them stripped could not silently turn every binding lookup
 * into a miss (which would read as "nobody owns any tab" — and reap them all).
 */
export const withoutPrefix = (prefix: string, storedKey: string) =>
  storedKey.startsWith(prefix) ? storedKey.slice(prefix.length) : storedKey;

/**
 * A fresh tab is created at `about:blank#<marker>` purely so the target it
 * became can be picked out of the browser's target list by URL: `tab new`
 * reports no CDP target id. Chrome keeps the fragment verbatim (measured),
 * and nothing can collide with a random one — whereas diffing the target
 * list before and after breaks the moment a page opens a popup.
 */
export const markerUrl = () => `about:blank#bb-${randomUUID().slice(0, 8)}`;
export const isMarker = (url: string) => /^about:blank#bb-[0-9a-f]{8}$/.test(url);

export interface PageRegistry {
  /**
   * The bound page's CDP websocket if a binding exists and its target is
   * still open — `null` otherwise. A miss here is never a reason to create
   * anything: this exists so a viewer (the stream route) can ask "is there a
   * real page to watch?" without ever being the reason one gets spawned.
   * Read-only: a stale binding is left exactly as found, for `pageUrlFor` to
   * reconcile on the next real use.
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
   * An empty list means "no browser is reachable", never "start one and look
   * again". The sweep runs every minute forever, so a launch here would hold
   * a Chromium open on an idle machine for good — which is why this module
   * has no way to launch one.
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
  /** Close this session's page and drop its binding. */
  closePage(sessionKey: string): Promise<void>;
  /** Drop this session's binding without touching the page. */
  forget(sessionKey: string): Promise<void>;
}

export function createPageRegistry(deps: PageRegistryDeps): PageRegistry {
  /** Every binding on disk, with the session key that owns it. */
  async function allBindings(): Promise<{ sessionKey: string; binding: Binding }[]> {
    const stored = await deps.kv.list("page:");
    const bindings: { sessionKey: string; binding: Binding }[] = [];
    for (const storedKey of stored) {
      const sessionKey = withoutPrefix("page:", storedKey);
      const binding = await deps.kv.get<Binding>(bindingKey(sessionKey));
      // A row under some other prefix (a host whose `list` ignores it) reads
      // back as undefined here and is simply not a binding.
      if (binding?.targetId) bindings.push({ sessionKey, binding });
    }
    return bindings;
  }

  /**
   * A live browser this plugin owns, found by probing the addresses it has
   * recorded. `null` means "no browser of ours is reachable", which is a
   * complete answer — and the only one available here, since this module
   * cannot start one.
   *
   * The identity check is not belt-and-braces, it is the whole point.
   * Debugging ports are ephemeral and a closed browser frees one at once, so
   * a recorded address is stale the moment its browser goes away — and the
   * reaper acts on what it finds there by CLOSING every tab no binding of
   * ours names. Against somebody else's Chromium (this machine runs its own
   * agent-browser sessions on ports from the same pool) that would mean
   * silently closing all of their tabs, once a minute, with nobody watching.
   * So: match the browser's uuid or treat the address as dead.
   *
   * A pointer with no recorded identity — a row written before this check
   * existed — is likewise treated as dead rather than trusted, and the next
   * page creation replaces it.
   */
  async function reachableBrowser(): Promise<string | null> {
    for (const storedKey of await deps.kv.list("origin:")) {
      const profile = withoutPrefix("origin:", storedKey);
      // Partial, deliberately: a row written before this check existed
      // carries no identity (or is a bare origin string), and the comparison
      // below is what has to reject it. No separate "has an id?" guard —
      // `undefined` already matches no browser, and a second branch saying
      // so would be one no test could ever fail against.
      const pointer = await deps.kv.get<Partial<BrowserPointer>>(originKey(profile));
      if (!pointer?.origin) continue;

      const browserUrl = await probeBrowserUrl(pointer.origin);
      if (!browserUrl) continue;
      if (browserIdOf(browserUrl) !== pointer.browserId) {
        deps.log(
          `${pointer.origin} is answering, but it is not the browser we left there — ignoring it`,
        );
        continue;
      }
      return browserUrl;
    }
    return null;
  }

  async function existingPageInfo(
    sessionKey: string,
  ): Promise<{ cdpUrl: string; url: string } | null> {
    const bound = await deps.kv.get<Binding>(bindingKey(sessionKey));
    // No origin covers both "never bound" and "bound before this field
    // existed" — either way, there is nothing to probe, so this must
    // report "no page" rather than fall back to a launch-capable lookup.
    if (!bound?.origin) return null;
    const browserUrl = await probeBrowserUrl(bound.origin);
    if (!browserUrl) return null;
    const open = await listPageTargets(browserUrl, deps.cdp);
    const target = open.find((candidate) => candidate.targetId === bound.targetId);
    if (!target) return null;
    // The marker fragment is an implementation detail of how this page was
    // found; showing it in the panel's address bar would be a lie about
    // where the page is.
    const url = isMarker(target.url) ? "about:blank" : target.url;
    return { cdpUrl: pageUrl(browserUrl, bound.targetId), url };
  }

  return {
    existingPageInfo,

    async existingPageUrl(sessionKey) {
      return (await existingPageInfo(sessionKey))?.cdpUrl ?? null;
    },

    async listOpenPages() {
      const bindings = await allBindings();
      const browserUrl = await reachableBrowser();
      if (!browserUrl) return [];
      const owner = new Map(
        bindings.map(({ sessionKey, binding }) => [binding.targetId, sessionKey]),
      );
      return (await listPageTargets(browserUrl, deps.cdp)).map((target) => ({
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
      const browserUrl = await reachableBrowser();
      // No browser, no page: there is nothing to close and nothing to report.
      if (!browserUrl) return;
      await closeTarget(browserUrl, targetId, deps.cdp);
    },

    async closePage(sessionKey) {
      const bound = await deps.kv.get<Binding>(bindingKey(sessionKey));
      if (!bound) return;

      if (!bound.origin) {
        // A pre-origin binding: there is no way to confirm a browser is
        // even there without launching one, and a cold-start cleanup must
        // not do that. Treat as already gone.
        deps.log(
          `closePage: ${sessionKey} has no recorded origin, clearing binding without probing`,
        );
        await deps.kv.delete(bindingKey(sessionKey));
        return;
      }

      const browserUrl = await probeBrowserUrl(bound.origin);
      if (!browserUrl) {
        // Unreachable: the page this binding names cannot exist either, so
        // there is nothing to close through CDP — just drop the binding
        // rather than launching a browser to close a page in it.
        deps.log(
          `closePage: browser for ${sessionKey} not reachable at ${bound.origin}, clearing binding`,
        );
        await deps.kv.delete(bindingKey(sessionKey));
        return;
      }

      // Real Chrome errors closing a targetId it no longer has (the panel's
      // close button, a crash, the reaper). The page is gone either way, so
      // that is confirmation, not a reason to strand the binding.
      await closeTarget(browserUrl, bound.targetId, deps.cdp).catch((error: Error) => {
        deps.log(`closePage: ${bound.targetId} already gone (${error.message})`);
      });
      await deps.kv.delete(bindingKey(sessionKey));
    },

    async forget(sessionKey) {
      await deps.kv.delete(bindingKey(sessionKey));
    },
  };
}
