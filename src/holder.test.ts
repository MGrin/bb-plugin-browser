import { describe, expect, it } from "vitest";
import {
  createPageHolder,
  holderKey,
  sharedPageNotice,
  displacedNotice,
} from "./holder.js";

// The defect this covers (MX-229): every thread spawned from one parent resolves
// to the SAME session key, so an orchestrator running three workers hands all
// three one Page. Last navigator wins and nothing says so — a worker reads or
// screenshots another thread's page and the artefact looks exactly like its own.
// One worker was displaced five times in ten minutes without noticing.

function fakeKv() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async <T,>(key: string) => store.get(key) as T | undefined,
    set: async (key: string, value: unknown) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  };
}

describe("notice text", () => {
  // These are what an agent actually reads, so their CONTENT is the fix, not
  // decoration on it. Each must name the other thread and the defence.
  it("names the owning thread when a spawned thread first touches a shared page", () => {
    const notice = sharedPageNotice("thr_parent");
    expect(notice).toContain("thr_parent");
    expect(notice).toContain("location.href");
  });

  it("names the thread that drove it more recently", () => {
    const notice = displacedNotice("thr_parent", "thr_other");
    expect(notice).toContain("thr_other");
    expect(notice).toContain("thr_parent");
    expect(notice).toContain("location.href");
  });

  it("never claims the caller previously held the page", () => {
    // A sibling's FIRST ever command also lands on a page someone else drove.
    // "since your last command" would be a false statement to that thread, and
    // a notice that is sometimes false is one an agent learns to discount.
    expect(displacedNotice("thr_parent", "thr_other")).not.toMatch(/your last command/i);
  });
});

describe("createPageHolder", () => {
  it("says nothing to a thread driving its own page", async () => {
    const holder = createPageHolder({ kv: fakeKv() });
    expect(await holder.claim("thr_a", "thr_a")).toBeNull();
    expect(await holder.claim("thr_a", "thr_a")).toBeNull();
  });

  it("warns a spawned thread that the page it just took is its parent's", async () => {
    const holder = createPageHolder({ kv: fakeKv() });
    const notice = await holder.claim("thr_parent", "thr_child");
    expect(notice).toContain("thr_parent");
  });

  it("tells the displaced thread who drove its page", async () => {
    const holder = createPageHolder({ kv: fakeKv() });
    await holder.claim("thr_parent", "thr_parent"); // the parent opens a page
    expect(await holder.claim("thr_parent", "thr_child")).toContain("thr_parent");
    // Now the parent comes back and finds the child has been driving.
    expect(await holder.claim("thr_parent", "thr_parent")).toContain("thr_child");
  });

  it("warns EVERY time the last driver is somebody else, not just the first", async () => {
    // The worker displaced five times in ten minutes must be told five times.
    // A once-per-page notice would have covered one of those five.
    const holder = createPageHolder({ kv: fakeKv() });
    for (let round = 0; round < 5; round += 1) {
      await holder.claim("thr_parent", "thr_noisy");
      expect(await holder.claim("thr_parent", "thr_quiet")).toContain("thr_noisy");
    }
  });

  it("records the caller as the driver, so the NEXT thread is warned", async () => {
    const kv = fakeKv();
    const holder = createPageHolder({ kv });
    await holder.claim("thr_parent", "thr_child");
    expect(kv.store.get(holderKey("thr_parent"))).toBe("thr_child");
  });

  it("reports the last driver for `bb browser tabs`", async () => {
    const holder = createPageHolder({ kv: fakeKv() });
    expect(await holder.lastDriver("thr_parent")).toBeNull();
    await holder.claim("thr_parent", "thr_child");
    expect(await holder.lastDriver("thr_parent")).toBe("thr_child");
  });

  it("stays silent for calls made outside any thread", async () => {
    // `scratch` is its own page and cannot be contended by a thread, so a
    // notice there would be noise on every CLI call made outside bb.
    const holder = createPageHolder({ kv: fakeKv() });
    expect(await holder.claim("scratch", undefined)).toBeNull();
  });

  it("forgets a page when its tab is closed, rather than leaking a row per tab", async () => {
    const kv = fakeKv();
    const holder = createPageHolder({ kv });
    await holder.claim("thr_parent", "thr_child");
    await holder.release("thr_parent");
    expect(kv.store.has(holderKey("thr_parent"))).toBe(false);
    // And a page that comes back is not still blaming a thread from before.
    expect(await holder.claim("thr_parent", "thr_parent")).toBeNull();
  });

  it("does not rewrite the record when the driver has not changed", async () => {
    // Every browser command claims. A write per call is a write per call for
    // the common single-thread case, which is most of them.
    const kv = fakeKv();
    let writes = 0;
    const counting = { ...kv, set: async (k: string, v: unknown) => { writes += 1; await kv.set(k, v); } };
    const holder = createPageHolder({ kv: counting });
    await holder.claim("thr_a", "thr_a");
    const afterFirst = writes;
    await holder.claim("thr_a", "thr_a");
    await holder.claim("thr_a", "thr_a");
    expect(writes).toBe(afterFirst);
  });
});
