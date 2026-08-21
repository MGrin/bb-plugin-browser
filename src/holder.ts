// Who last drove a page — the one thing a shared tab never told anyone.
//
// A page is keyed by session (session-key.ts), and that key is the ROOT of the
// thread's parent chain. One spawned worker sharing its coordinator's page is
// the deliberate design. SEVERAL siblings sharing it is not: they resolve to
// the same key, `tabs.tabFor` hands them all one Page, and every verb reports
// success on whatever page it lands on.
//
// That is worse than losing your page, because THE ARTEFACT STILL LOOKS LIKE AN
// ARTEFACT. A screenshot of another thread's logged-in page has the same chrome,
// the same nav, and plausibly supports the same claim; a reader cannot tell. One
// worker on 2026-08-21 was displaced five times in ten minutes and said of a
// capture it never took: "had I filed it, it would have read as evidence."
//
// This module does not stop the sharing — that is a behaviour change, and it is
// mgrin's to make. It removes the SILENCE, which is the part that turns a lost
// page into a wrong conclusion. A thread is told, in the result of the command
// it just ran, that the page it is looking at was last driven by somebody else.
//
// Deliberately a record of the LAST DRIVER and not a lock. A lock would have to
// be released, and a worker that dies holding one wedges the browser for every
// other thread — a strictly worse failure than the one being fixed. Reporting
// cannot deadlock.

/** Which thread last drove a page. Value is a thread id. */
export const holderKey = (sessionKey: string) => `holder:${sessionKey}`;

/**
 * The defence three workers arrived at independently, in the words that worked.
 *
 * Every finding either of them kept was one where the url was asserted in the
 * same call that produced the value; every artefact that was not, was deleted.
 * Separate `open` then `read` lost every time — the gap is seconds. So the
 * notice carries the remedy rather than only the bad news, because a warning an
 * agent cannot act on is one it routes around.
 */
const DEFENCE =
  "Read location.href IN THE SAME COMMAND as any measurement — a separate open " +
  "then read loses the page in the gap, and the gap is seconds.";

/** A spawned thread's first touch of the page it inherited. */
export function sharedPageNotice(sessionKey: string): string {
  return (
    `⚠ SHARED PAGE — this tab belongs to ${sessionKey} and is shared by every thread ` +
    `spawned from it, not by you alone. A sibling can navigate it between your commands ` +
    `and nothing will stop it. ${DEFENCE}`
  );
}

/**
 * Somebody else drove this page more recently than the caller did.
 *
 * Phrased to be true on a sibling's FIRST command as well as on a displacement:
 * that thread never held the page, so "since your last command" would be a false
 * statement, and a notice that is sometimes false is one an agent discounts.
 */
export function displacedNotice(sessionKey: string, driver: string): string {
  return (
    `⚠ THIS PAGE IS NOT YOURS ALONE — ${driver} drove this tab more recently than you did, ` +
    `so whatever is loaded now was put there by ${driver} and not by you. The tab is shared ` +
    `by every thread spawned from ${sessionKey}. Anything you read or capture here may be ` +
    `${driver}'s page. ${DEFENCE}`
  );
}

export interface HolderDeps {
  kv: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
}

export interface PageHolder {
  /**
   * Record this caller as the page's driver, and report what that displaced.
   *
   * Returns the notice to put in front of the command's own result, or null
   * when there is nothing to say. Called BEFORE the action runs, deliberately:
   * the notice describes the state the action is about to execute in, which is
   * what the reader needs in order to interpret the output underneath it.
   */
  claim(sessionKey: string, threadId: string | undefined): Promise<string | null>;
  /** Who last drove this page — for `bb browser tabs`. */
  lastDriver(sessionKey: string): Promise<string | null>;
  /** Forget a page whose tab is gone, rather than leaking a row per tab. */
  release(sessionKey: string): Promise<void>;
}

export function createPageHolder(deps: HolderDeps): PageHolder {
  return {
    async claim(sessionKey, threadId) {
      // A call made outside any thread gets the `scratch` page, which no thread
      // can reach. There is nobody to contend with and nobody to name.
      if (!threadId) return null;

      const previous = await deps.kv.get<string>(holderKey(sessionKey));
      if (previous === threadId) return null;

      await deps.kv.set(holderKey(sessionKey), threadId);
      if (previous) return displacedNotice(sessionKey, previous);
      // Nobody has driven this page yet. Only worth saying to a thread that is
      // not the page's own — the owner sharing with nobody needs no warning.
      return threadId === sessionKey ? null : sharedPageNotice(sessionKey);
    },

    async lastDriver(sessionKey) {
      return (await deps.kv.get<string>(holderKey(sessionKey))) ?? null;
    },

    async release(sessionKey) {
      await deps.kv.delete(holderKey(sessionKey));
    },
  };
}
