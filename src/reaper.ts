// Closing pages nobody is using — which is load-bearing, not hygiene.
//
// The shared Chromium profile RESTORES its tabs when it relaunches (measured
// in Task 9b: 21 leftover tabs came back after a plugin reload, seven of them
// duplicates of the same page). Nothing else in this plugin ever prunes them,
// and Chrome mints fresh target ids on restore, so a restored tab is bound to
// nobody and no later binding will ever name it. Without this module the
// browser accumulates tabs permanently, across restarts, forever.
//
// Two passes, because there are two ways a page stops being anybody's:
//
//   idle   — a session still owns the page but has not used it for a while.
//            Closed through `pages.closePage`, which closes the tab AND drops
//            the binding.
//   unbound — an open page target no binding names at all: a restored tab, a
//            page whose binding was lost, a tab left by a crash mid-create.
//            Closed by target id, after a grace period.
//
// The order matters and so does the direction: reaping CLOSES the tab and
// only then forgets the binding. A forgotten binding whose tab is still open
// is the worst outcome available — the tab survives forever and nothing
// references it — so a close that fails keeps its session and is reported,
// never quietly dropped.
//
// Time is a parameter rather than a call to Date.now(), because a test that
// waits out a real 30-minute timeout is not a test.

/** One open page in the shared browser, and who (if anyone) is bound to it. */
export interface OpenPage {
  targetId: string;
  url: string;
  /** The session key whose binding names this target, or null for nobody's. */
  sessionKey: string | null;
}

export interface ReaperDeps {
  /**
   * How long a page may go unused before it is closed. Resolved at every
   * sweep rather than captured once, so changing the setting takes effect
   * without a plugin reload — the same reason `EngineOptions.headed` is a
   * thunk.
   */
  idleMs(): Promise<number>;
  /**
   * How long a page must have been observed with no binding naming it before
   * it is closed. `pages.createPage` opens the tab and only then writes the
   * binding; a sweep landing inside that window must not close the page a
   * thread is about to be handed. One full sweep interval covers it with
   * room to spare, and the cost of being wrong the other way is one extra
   * minute of a dead tab.
   */
  graceMs: number;
  /** Closes the tab and drops the binding. Rejects if the tab survived. */
  closePage(sessionKey: string): Promise<void>;
  /** Every open page in the shared browser. Must never launch one. */
  listOpenPages(): Promise<OpenPage[]>;
  /** Closes one page by target id. Must never launch a browser. */
  closeUnboundPage(targetId: string): Promise<void>;
  log(message: string): void;
  warn(message: string): void;
}

export interface Reaper {
  /** Records that this session just used its page. */
  touch(sessionKey: string, now?: number): void;
  /** A viewer arrived: this session's page is in use until it leaves. */
  watch(sessionKey: string): void;
  unwatch(sessionKey: string): void;
  /** Stop tracking a session whose page is already gone. */
  forget(sessionKey: string): void;
  sweep(now?: number): Promise<void>;
}

/** Minutes of idleness before a page is closed, when the setting is unusable. */
export const DEFAULT_IDLE_MINUTES = 30;

/**
 * The setting arrives as free text: bb's settings descriptors have string,
 * boolean, select and project — there is no number. Anything unusable falls
 * back to the default rather than to 0 (which would close a page out from
 * under live work) or to Infinity (which would never close one, reinstating
 * the bug this module exists to fix).
 */
export function idleMsFrom(raw: string | undefined): number {
  const minutes = Number((raw ?? "").trim());
  const usable = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_IDLE_MINUTES;
  return usable * 60_000;
}

export function createReaper(deps: ReaperDeps): Reaper {
  const lastUsed = new Map<string, number>();
  const viewers = new Map<string, number>();
  // When each currently-unbound target was first seen unbound. Not "when it
  // was created": this process may only have started a moment ago, and the
  // point of the grace period is that WE have watched it be unowned, not
  // that it is old.
  const unboundSince = new Map<string, number>();

  async function idlePass(now: number): Promise<void> {
    const idleMs = await deps.idleMs();
    for (const [sessionKey, used] of [...lastUsed]) {
      if (viewers.has(sessionKey)) continue;
      if (now - used < idleMs) continue;
      deps.log(`closing idle page for ${sessionKey}`);
      try {
        await deps.closePage(sessionKey);
        // Only after the close actually succeeded. Forgetting first would
        // leave a live tab nothing references.
        lastUsed.delete(sessionKey);
      } catch (error) {
        deps.warn(
          `could not close the idle page for ${sessionKey}, will retry: ${messageOf(error)}`,
        );
      }
    }
  }

  async function unboundPass(pages: OpenPage[], now: number): Promise<void> {
    const present = new Set(pages.map((page) => page.targetId));
    for (const targetId of [...unboundSince.keys()]) {
      if (!present.has(targetId)) unboundSince.delete(targetId);
    }

    for (const page of pages) {
      if (page.sessionKey !== null) {
        // It found an owner while we were waiting — the create-then-bind
        // window, most likely. Its grace period starts over if it ever
        // loses one again.
        unboundSince.delete(page.targetId);
        continue;
      }
      const since = unboundSince.get(page.targetId);
      if (since === undefined) {
        unboundSince.set(page.targetId, now);
        continue;
      }
      if (now - since < deps.graceMs) continue;

      deps.log(`closing page ${page.targetId} (${page.url}) — no thread is bound to it`);
      try {
        await deps.closeUnboundPage(page.targetId);
        unboundSince.delete(page.targetId);
      } catch (error) {
        // Kept in the map, so the next sweep tries again immediately rather
        // than starting another grace period.
        deps.warn(`could not close unbound page ${page.targetId}: ${messageOf(error)}`);
      }
    }
  }

  return {
    touch(sessionKey, now = Date.now()) {
      lastUsed.set(sessionKey, now);
    },

    watch(sessionKey) {
      viewers.set(sessionKey, (viewers.get(sessionKey) ?? 0) + 1);
    },

    unwatch(sessionKey) {
      const count = (viewers.get(sessionKey) ?? 1) - 1;
      if (count <= 0) viewers.delete(sessionKey);
      else viewers.set(sessionKey, count);
    },

    forget(sessionKey) {
      lastUsed.delete(sessionKey);
      viewers.delete(sessionKey);
    },

    async sweep(now = Date.now()) {
      // Listed first, and separately, so a browser that cannot be reached
      // (the ordinary case — nothing has opened one yet) still leaves the
      // idle pass free to run against the bindings it already knows about.
      let pages: OpenPage[] | null = null;
      try {
        pages = await deps.listOpenPages();
      } catch (error) {
        deps.warn(`could not list the browser's pages: ${messageOf(error)}`);
      }

      // A page bound before this process started has no touch to its name:
      // the plugin was reloaded, or bb restarted, while the browser kept
      // running. Start its clock at first sight — we cannot know when it was
      // really last used, and "never reaped" is how the accumulation this
      // module exists to stop gets in again.
      if (pages) {
        for (const page of pages) {
          if (page.sessionKey && !lastUsed.has(page.sessionKey)) {
            lastUsed.set(page.sessionKey, now);
          }
        }
      }

      await idlePass(now);
      // After the idle pass, so a page it just closed is already gone from
      // the browser rather than looking briefly like an orphan.
      if (pages) await unboundPass(pages, now);
    },
  };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** How often the background service sweeps. */
export const SWEEP_INTERVAL_MS = 60_000;

/**
 * The sweep loop, as a plain function so it can be tested without a bb host.
 * It resolves when the signal aborts, which is the contract
 * `bb.background.service` expects, and it never rejects: a service that
 * throws is restarted with backoff, and one bad sweep (a browser that went
 * away mid-list, say) is not worth tearing the service down for.
 */
export async function runSweeps(
  signal: AbortSignal,
  reaper: Pick<Reaper, "sweep">,
  options: { intervalMs?: number; warn: (message: string) => void },
): Promise<void> {
  const intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;
  while (!signal.aborted) {
    await sleep(intervalMs, signal);
    if (signal.aborted) return;
    try {
      await reaper.sweep(Date.now());
    } catch (error) {
      options.warn(`sweep failed: ${messageOf(error)}`);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    // Removed again in `done`, so a long-lived signal does not accumulate one
    // listener per sweep for the life of the plugin.
    signal.addEventListener("abort", done, { once: true });
  });
}

export interface ThreadTeardownDeps {
  resolveSessionKey(threadId: string): Promise<string>;
  closePage(sessionKey: string): Promise<void>;
  forget(sessionKey: string): void;
  warn(message: string): void;
}

/**
 * What to do when a thread is archived or deleted: close its page.
 *
 * Two rules, both learned from what these events actually deliver.
 *
 * It NEVER rejects. bb dispatches thread events fire-and-forget, so a
 * rejected promise here is an unhandled rejection in the plugin host — for
 * the entirely ordinary case of a thread that never opened a browser at all.
 * Being called twice for one thread (archived, then deleted) is ordinary too,
 * and the second call is a no-op inside `closePage`.
 *
 * And it only tears down a session this thread OWNS. A spawned child shares
 * its parent's session key (session-key.ts), so archiving one subagent must
 * never close the coordinator's page out from under a fleet still working.
 */
export function createThreadTeardown(
  deps: ThreadTeardownDeps,
): (payload: { thread: { id: string } }) => Promise<void> {
  return async ({ thread }) => {
    try {
      const sessionKey = await deps.resolveSessionKey(thread.id);
      if (sessionKey !== thread.id) return;
      deps.forget(sessionKey);
      await deps.closePage(sessionKey);
    } catch (error) {
      deps.warn(`could not close the page for thread ${thread.id}: ${messageOf(error)}`);
    }
  };
}
