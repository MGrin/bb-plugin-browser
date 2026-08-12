// Closing tabs nobody is using, and nothing else.
//
// Two rules, both learned the hard way in v1:
//
//   1. Only tabs THIS PLUGIN opened are ever closed. v1's reaper closed
//      anything no binding named, which in a real window is precisely the tab
//      a human opened to log in — it closed one out from under a user inside
//      two minutes.
//   2. The browser is never shut down. v1 shut it down when it looked empty,
//      which ended the process holding every thread's handle on its page and
//      set off a loop that destroyed a page every thirty seconds. The browser
//      here is a real window a human may be using; it closes when they close
//      it, or when they ask for `bb browser quit`.
//
// Time is a parameter so a test does not have to wait out a real timeout.

/** One open tab, as the reaper needs to see it. */
export interface ReapableTab {
  targetId: string;
  /** The session key whose binding names it, or null for nobody's. */
  sessionKey: string | null;
  /** Whether this plugin opened it. A human's tab is never touched. */
  ours: boolean;
}

export interface Reaper2Deps {
  /** Minutes of disuse before one of our tabs is closed. */
  idleMs(): Promise<number>;
  listTabs(): Promise<ReapableTab[]>;
  closeTarget(targetId: string): Promise<void>;
  log(message: string): void;
  warn(message: string): void;
}

export interface Reaper2 {
  touch(sessionKey: string, now?: number): void;
  /** In use until the matching unwatch, regardless of idleness. */
  watch(sessionKey: string): void;
  unwatch(sessionKey: string): void;
  forget(sessionKey: string): void;
  sweep(now?: number): Promise<void>;
}

export const DEFAULT_IDLE_MINUTES = 30;

/**
 * The setting arrives as free text — bb has no number descriptor. Anything
 * unusable falls back to the default rather than to 0 (which would close a tab
 * out from under live work) or Infinity (which would never close one).
 */
export function idleMsFrom(raw: string | undefined): number {
  const minutes = Number((raw ?? "").trim());
  const usable = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_IDLE_MINUTES;
  return usable * 60_000;
}

export function createReaper2(deps: Reaper2Deps): Reaper2 {
  const lastUsed = new Map<string, number>();
  const holds = new Map<string, number>();
  /** When each of our unowned tabs was first seen with nobody bound to it. */
  const orphanedSince = new Map<string, number>();

  /**
   * How long one of our tabs may be orphaned — bound to no thread — before it
   * is closed. A tab is created and its binding written a moment later, so a
   * sweep landing inside that window must not take it.
   */
  const ORPHAN_GRACE_MS = 90_000;

  return {
    touch(sessionKey, now = Date.now()) {
      lastUsed.set(sessionKey, now);
    },
    watch(sessionKey) {
      holds.set(sessionKey, (holds.get(sessionKey) ?? 0) + 1);
    },
    unwatch(sessionKey) {
      const remaining = (holds.get(sessionKey) ?? 1) - 1;
      if (remaining <= 0) holds.delete(sessionKey);
      else holds.set(sessionKey, remaining);
    },
    forget(sessionKey) {
      lastUsed.delete(sessionKey);
      holds.delete(sessionKey);
    },

    async sweep(now = Date.now()) {
      let tabs: ReapableTab[];
      try {
        tabs = await deps.listTabs();
      } catch (error) {
        // The browser being unreachable is ordinary — nobody has opened one
        // yet, or the human closed it. It is never a reason to act.
        deps.warn(`could not list tabs: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      const present = new Set(tabs.map((tab) => tab.targetId));
      for (const targetId of [...orphanedSince.keys()]) {
        if (!present.has(targetId)) orphanedSince.delete(targetId);
      }

      for (const tab of tabs) {
        // The line this plugin does not cross.
        if (!tab.ours) continue;

        if (tab.sessionKey) {
          orphanedSince.delete(tab.targetId);
          if (holds.has(tab.sessionKey)) continue;
          const used = lastUsed.get(tab.sessionKey);
          // A tab bound before this process started has no timestamp: start
          // its clock now rather than treating it as infinitely idle.
          if (used === undefined) {
            lastUsed.set(tab.sessionKey, now);
            continue;
          }
          if (now - used < (await deps.idleMs())) continue;
          deps.log(`closing idle tab for ${tab.sessionKey}`);
          try {
            await deps.closeTarget(tab.targetId);
            lastUsed.delete(tab.sessionKey);
          } catch (error) {
            deps.warn(
              `could not close idle tab for ${tab.sessionKey}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          continue;
        }

        // Ours, but nobody is bound to it: a thread that was torn down, or a
        // create whose binding never landed.
        const since = orphanedSince.get(tab.targetId);
        if (since === undefined) {
          orphanedSince.set(tab.targetId, now);
          continue;
        }
        if (now - since < ORPHAN_GRACE_MS) continue;
        deps.log(`closing our orphaned tab ${tab.targetId}`);
        try {
          await deps.closeTarget(tab.targetId);
          orphanedSince.delete(tab.targetId);
        } catch (error) {
          deps.warn(
            `could not close orphaned tab ${tab.targetId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    },
  };
}
