// Which browser page a thread drives: its own, keyed by its own id.
//
// This used to walk the parent chain to the root, so a spawned child shared its
// parent's page (MX-229) — right while a spawned thread was a subagent of its
// coordinator. Since 2026-09-21 a project's operator spawns independent,
// parallel WORKER threads, and a shared root made every worker drive the
// operator's tab in a signed-in profile: one could navigate a page away from
// under another mid-read, and nothing refused it (MX-1080). So the key is the
// calling thread, full stop. Logins are still shared — one profile — only the
// TAB is private.

/** Calls made outside any thread share this key. */
export const SCRATCH_SESSION_KEY = "scratch";

export type SessionKeyResolver = (
  threadId: string | undefined,
) => Promise<string>;

export const resolveSessionKey: SessionKeyResolver = async (threadId) =>
  threadId || SCRATCH_SESSION_KEY;
