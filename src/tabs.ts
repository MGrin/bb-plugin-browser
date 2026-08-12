// One tab per thread, named by something the browser owns.
//
// This is the whole reason v2 exists. v1 identified a thread's tab by an
// agent-browser LABEL, which lived in that session's daemon process — so any
// restart of the daemon lost every label, and "recovery" replaced the page
// rather than finding it. A thread's work, and twice a half-finished login,
// went with it.
//
// A CDP targetId lives in the BROWSER. The plugin can reload, bb can restart,
// this process can die — the id still names the same tab, and reattaching
// finds it. Nothing here caches a handle that can go stale behind our back;
// every lookup asks the browser.
import type { Browser, BrowserContext, Page } from "playwright-core";

/** What a thread's tab is, once we have found or made it. */
export interface ThreadTab {
  page: Page;
  targetId: string;
}

export interface TabsDeps {
  /** The connected browser, from Playwright's connectOverCDP. */
  browser: () => Promise<Browser>;
  kv: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
  };
  log: (message: string) => void;
}

/** Which tab belongs to a thread. The value is a CDP target id. */
export const tabKey = (sessionKey: string) => `tab:${sessionKey}`;
/** That this plugin opened a tab — so the reaper never touches a human's. */
export const ownedKey = (targetId: string) => `owned:${targetId}`;

export interface Tabs {
  /** This thread's tab, created if it does not have one yet. */
  tabFor(sessionKey: string): Promise<ThreadTab>;
  /** This thread's tab if it exists — never creates one. */
  existingTab(sessionKey: string): Promise<ThreadTab | null>;
  /** Close this thread's tab and forget it. Safe to call twice. */
  closeTab(sessionKey: string): Promise<void>;
  /** Every open tab, with whether this plugin opened it and who holds it. */
  listTabs(): Promise<
    { targetId: string; url: string; sessionKey: string | null; ours: boolean }[]
  >;
  /** Close a tab by target id — used by the reaper for our own orphans. */
  closeTarget(targetId: string): Promise<void>;
}

/**
 * The target id behind a Playwright page.
 *
 * Playwright does not expose it, so it comes from a CDP session on the page.
 * Worth the round trip: it is the only identifier that outlives this process,
 * and everything in this module is built on that property.
 */
async function targetIdOf(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    const info = (await session.send("Target.getTargetInfo")) as {
      targetInfo: { targetId: string };
    };
    return info.targetInfo.targetId;
  } finally {
    await session.detach().catch(() => {});
  }
}

/** Every page in the browser, paired with its target id. */
async function pagesWithIds(context: BrowserContext): Promise<{ page: Page; targetId: string }[]> {
  const pages = context.pages().filter((page) => !page.isClosed());
  return Promise.all(
    pages.map(async (page) => ({ page, targetId: await targetIdOf(page) })),
  );
}

export function createTabs(deps: TabsDeps): Tabs {
  /**
   * The one context. connectOverCDP surfaces the browser's existing profile as
   * a single context — which is what we want: every thread shares the cookie
   * jar, so a login done once serves all of them, and only the TAB is private.
   */
  async function context(): Promise<BrowserContext> {
    const browser = await deps.browser();
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error("the agents' browser reported no context — is it still running?");
    }
    return contexts[0]!;
  }

  // Two callers arriving for the same thread at once must not open two tabs;
  // the loser's tab would be orphaned immediately and the thread would hold a
  // handle nothing else agreed on. Same shape of fix as v1 needed, kept here
  // because the race is inherent, not a v1 artefact.
  const inflight = new Map<string, Promise<ThreadTab>>();

  async function findExisting(sessionKey: string): Promise<ThreadTab | null> {
    const targetId = await deps.kv.get<string>(tabKey(sessionKey));
    if (!targetId) return null;
    const found = (await pagesWithIds(await context())).find(
      (candidate) => candidate.targetId === targetId,
    );
    if (!found) return null;
    return { page: found.page, targetId };
  }

  async function create(sessionKey: string): Promise<ThreadTab> {
    const page = await (await context()).newPage();
    const targetId = await targetIdOf(page);
    await deps.kv.set(tabKey(sessionKey), targetId);
    // Recorded separately from the binding and OUTLIVING it: a thread's tab
    // can stop being that thread's (teardown, an explicit close) while still
    // being a tab this plugin opened rather than one the human did. That
    // distinction is what lets the reaper clear its own debris without ever
    // reaching for a tab somebody is logged into.
    await deps.kv.set(ownedKey(targetId), true);
    deps.log(`opened a tab for ${sessionKey} (${targetId})`);
    return { page, targetId };
  }

  return {
    async existingTab(sessionKey) {
      return findExisting(sessionKey);
    },

    async tabFor(sessionKey) {
      const pending = inflight.get(sessionKey);
      if (pending) return pending;

      const work = (async () => {
        const existing = await findExisting(sessionKey);
        if (existing) return existing;
        return create(sessionKey);
      })().finally(() => {
        inflight.delete(sessionKey);
      });

      inflight.set(sessionKey, work);
      return work;
    },

    async closeTab(sessionKey) {
      const targetId = await deps.kv.get<string>(tabKey(sessionKey));
      await deps.kv.delete(tabKey(sessionKey));
      if (!targetId) return;
      const found = (await pagesWithIds(await context())).find(
        (candidate) => candidate.targetId === targetId,
      );
      // The ownership record goes with the tab, not with the binding: keeping
      // it would leak a row per closed tab forever.
      await deps.kv.delete(ownedKey(targetId));
      if (found) await found.page.close().catch(() => {});
    },

    async closeTarget(targetId) {
      const found = (await pagesWithIds(await context())).find(
        (candidate) => candidate.targetId === targetId,
      );
      await deps.kv.delete(ownedKey(targetId));
      if (found) await found.page.close().catch(() => {});
    },

    async listTabs() {
      const open = await pagesWithIds(await context());
      const bindings = new Map<string, string>();
      for (const storedKey of await deps.kv.list("tab:")) {
        const sessionKey = storedKey.startsWith("tab:") ? storedKey.slice(4) : storedKey;
        const targetId = await deps.kv.get<string>(tabKey(sessionKey));
        if (targetId) bindings.set(targetId, sessionKey);
      }
      return Promise.all(
        open.map(async (entry) => ({
          targetId: entry.targetId,
          url: entry.page.url(),
          sessionKey: bindings.get(entry.targetId) ?? null,
          ours: (await deps.kv.get<boolean>(ownedKey(entry.targetId))) === true,
        })),
      );
    },
  };
}
