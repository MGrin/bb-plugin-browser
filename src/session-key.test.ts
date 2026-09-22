import { describe, expect, it } from "vitest";
import { resolveSessionKey, SCRATCH_SESSION_KEY } from "./session-key.js";

describe("resolveSessionKey", () => {
  it("returns scratch outside any thread", async () => {
    expect(await resolveSessionKey(undefined)).toBe(SCRATCH_SESSION_KEY);
    expect(await resolveSessionKey("")).toBe(SCRATCH_SESSION_KEY);
  });

  it("returns the thread itself", async () => {
    expect(await resolveSessionKey("thr_a")).toBe("thr_a");
  });

  // THE test that goes red if the parent walk comes back (MX-1080). Two
  // workers spawned by one operator are independent and run in parallel; one
  // shared key meant one tab, so either could navigate the other's page away
  // mid-read in a signed-in profile. The resolver takes no host handle at all,
  // so it cannot read a parent chain — reintroducing one breaks this file.
  it("gives spawned sibling workers their OWN keys, not their operator's", async () => {
    const [operator, workerA, workerB] = await Promise.all(
      ["thr_operator", "thr_worker_a", "thr_worker_b"].map((id) => resolveSessionKey(id)),
    );
    expect(new Set([operator, workerA, workerB]).size).toBe(3);
    expect(workerA).toBe("thr_worker_a");
    expect(workerB).toBe("thr_worker_b");
  });

  // A `thread.deleted` event arrives for a row the host has already removed.
  // The teardown closes the tab keyed by the thread's own id, so the key must
  // not depend on reading the thread at all.
  it("resolves a deleted thread to its own id without asking the host", async () => {
    expect(await resolveSessionKey("thr_deleted")).toBe("thr_deleted");
  });
});
