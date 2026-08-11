// Putting a thread on a page of its own: the half that is allowed to create.
//
// Everything here can start a browser and open a tab, which is why it is a
// module of its own and why it holds the only reference to `engine` outside
// operations.ts. Its read-only counterpart is page-registry.ts, which cannot
// — that split is what enforces "watching never creates a page, and never
// launches a browser" by the import graph instead of by a comment. The
// stream route, the panel's read path, the screencast and the reaper all
// depend on the registry; only this module and operations.ts depend on the
// engine.
//
// Remembering a page matters because a thread that comes back after a bb
// restart should still be on its page. Verifying matters because a page can
// vanish without telling us — the panel's close button, a crash, the idle
// reaper — and a stale id must produce a fresh page rather than an error.
import type { CdpOptions } from "./cdp.js";
import type { Engine } from "./engine.js";
import {
  browserIdOf,
  closeTarget,
  httpOriginOf,
  listPageTargets,
  pageUrl,
} from "./browser-endpoint.js";
import {
  bindingKey,
  markerUrl,
  originKey,
  withoutPrefix,
  type Binding,
  type BrowserPointer,
  type PageRegistry,
} from "./page-registry.js";

export type { OpenPage } from "./page-registry.js";

export interface PagesDeps {
  /**
   * `run` is here because a page has to be created BY the session that will
   * drive it: labels are session-local (measured — session B cannot see, or
   * select by, a label session A assigned), and `tab new --label` is the
   * only command that assigns one.
   */
  engine: Pick<Engine, "browserCdpUrl" | "run" | "shutdown" | "shutdownAll">;
  kv: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
  };
  /**
   * The read-only half. Passed in rather than constructed here so that the
   * one instance the whole plugin shares is the one the stream route, the
   * panel and the reaper hold — and so that nothing has to hand those a
   * launch-capable object just to give them a lookup.
   */
  registry: PageRegistry;
  log: (message: string) => void;
  /** See PageRegistryDeps.cdp — a test's way to shorten the connect timeout. */
  cdp?: CdpOptions;
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

/**
 * Everything the registry can answer, plus the four things only a
 * launch-capable module can do: create a page, replace one, and take a
 * browser (or every browser) down.
 */
export interface Pages extends PageRegistry {
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
   * Close a profile's browser and forget where it was — the two halves of
   * one act, which is why they are not two calls a caller has to remember to
   * pair. A remembered address whose browser has gone points at a freed
   * ephemeral port, and the next process to take that port is somebody
   * else's browser; the identity check in the registry refuses to adopt it,
   * and this makes sure there is nothing stale to refuse.
   */
  shutdownBrowser(profile: string): Promise<void>;
  /** The same, for every browser this engine has running. */
  shutdownAllBrowsers(): Promise<void>;
}

/**
 * The label every thread's page is created under. One constant, not a
 * per-thread name: a session drives exactly one page, and labels are scoped
 * to the session that assigned them, so there is nothing for a thread-shaped
 * label to disambiguate.
 */
export const TAB_LABEL = "bbpage";

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

    const open = await listPageTargets(browserWsUrl, deps.cdp);
    const created = open.find((target) => target.url === marker);
    if (!created) {
      throw new Error(
        `could not open a page for this thread: ${made.stderr.trim() || "no reason given"}`,
      );
    }

    const origin = httpOriginOf(browserWsUrl);
    const binding: Binding = {
      profile,
      targetId: created.targetId,
      origin,
      tab: TAB_LABEL,
    };
    await deps.kv.set(bindingKey(sessionKey), binding);
    // Remembered per profile as well as per binding: the reaper has to be
    // able to find this browser after every binding for it is gone, which is
    // exactly the state a restart leaves behind together with the tabs it
    // restored. With the browser's uuid, so that going back to the address
    // later can tell "our browser" from "whatever now holds that port".
    const browserId = browserIdOf(browserWsUrl);
    if (browserId) {
      const pointer: BrowserPointer = { origin, browserId };
      await deps.kv.set(originKey(profile), pointer);
    }
    deps.log(`created page ${created.targetId} for ${sessionKey} on ${profile}`);
    return { cdpUrl: pageUrl(browserWsUrl, created.targetId), browserWsUrl, tab: TAB_LABEL };
  }

  async function resolveBinding(
    sessionKey: string,
    profile: string,
    replace: boolean,
  ): Promise<PageBinding> {
    const browserWsUrl = await deps.engine.browserCdpUrl(profile);
    const bound = await deps.kv.get<Binding>(bindingKey(sessionKey));
    const open = await listPageTargets(browserWsUrl, deps.cdp);
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
      await closeTarget(browserWsUrl, bound.targetId, deps.cdp).catch((error: Error) => {
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
  // promise per key, dropped once settled — including when it REJECTS, which
  // is what keeps a failed or timed-out resolution from becoming this
  // session's permanent answer.
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

  return {
    // Every read-only answer comes from the one registry the rest of the
    // plugin holds, so a lookup made through `pages` and the same lookup
    // made through the registry can never diverge.
    ...deps.registry,

    bindingFor,
    rebind,

    async pageUrlFor(sessionKey, profile) {
      return (await bindingFor(sessionKey, profile)).cdpUrl;
    },

    async shutdownBrowser(profile) {
      try {
        await deps.engine.shutdown(profile);
      } finally {
        // In a finally: a close that failed may still have taken the browser
        // down, and forgetting an address needlessly costs only a sweep that
        // finds nothing, while keeping a stale one is the hazard itself.
        await deps.kv.delete(originKey(profile));
      }
    },

    async shutdownAllBrowsers() {
      try {
        await deps.engine.shutdownAll();
      } finally {
        for (const storedKey of await deps.kv.list("origin:")) {
          await deps.kv.delete(originKey(withoutPrefix("origin:", storedKey)));
        }
      }
    },
  };
}
