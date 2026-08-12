// Which browser page a thread drives.
//
// A spawned child shares its parent's page, so a fleet's subagents and their
// coordinator work one page and one cookie jar. Walking to the root of the
// parent chain gives that key. A fork is a peer exploration, not a subagent,
// so it starts its own.
import type { BbPluginApi } from "@bb/plugin-sdk";

/** Calls made outside any thread share this key. */
export const SCRATCH_SESSION_KEY = "scratch";

export type SessionKeyResolver = (
  threadId: string | undefined,
) => Promise<string>;

export function createSessionKeyResolver(bb: BbPluginApi): SessionKeyResolver {
  // A thread's ancestry never changes, so a resolved key is cacheable forever.
  const cache = new Map<string, string>();

  return async (threadId) => {
    if (!threadId) return SCRATCH_SESSION_KEY;
    const cached = cache.get(threadId);
    if (cached) return cached;

    const seen: string[] = [];
    let current = threadId;
    let root = threadId;
    while (!seen.includes(current)) {
      seen.push(current);
      let thread: { parentThreadId: string | null; childOrigin: string | null } | null;
      try {
        thread = await bb.sdk.threads.get({ threadId: current });
      } catch {
        seen.pop(); // A failed fetch must not be cached — it may be transient.
        break; // An unreadable thread means root stays at the last node we could read.
      }
      // A host that ANSWERS with null — the ordinary shape of a `thread.deleted`
      // event for a row the host has already removed — is not a thread with no
      // parent. Reading `.childOrigin` off it throws a TypeError out of the
      // resolver, and the caller that matters is the thread teardown: it would
      // only warn, and the page would be left to the idle reaper half an hour
      // later. So null is an unreadable thread, handled exactly like a throw —
      // the walk stops, nothing is cached, and a deleted thread still resolves
      // to its own id, which is what makes the teardown close ITS page.
      if (!thread) {
        seen.pop();
        break;
      }
      root = current; // This node was successfully read, so it's a valid stopping point.
      if (thread.childOrigin === "fork") break;
      if (!thread.parentThreadId) break;
      current = thread.parentThreadId;
    }

    for (const id of seen) cache.set(id, root);
    return root;
  };
}
