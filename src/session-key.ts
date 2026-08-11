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
      let thread: { parentThreadId: string | null; childOrigin: string | null };
      try {
        thread = await bb.sdk.threads.get({ threadId: current });
      } catch {
        break; // An unreadable thread means root stays at the last node we could read.
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
