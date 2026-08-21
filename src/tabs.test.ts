import { describe, expect, it } from "vitest";
import { holderKey } from "./holder.js";
import type { TabsDeps } from "./tabs.js";
import { createTabs, ownedKey, tabKey, TARGET_ID_TIMEOUT_MS, withDeadline } from "./tabs.js";

// The regression these cover: `targetIdOf` asked the browser for a tab's target
// id with no timeout at all, on every tool call, for every open tab — and it ran
// inside `tabFor`, which finishes before actions.ts arms its 20s action timeout.
// One unresponsive tab therefore hung the call indefinitely. Measured worst case
// before the fix: a 1509-second handler.

describe("withDeadline", () => {
  it("passes a value straight through when the work is prompt", async () => {
    await expect(withDeadline(Promise.resolve("t_1"), 1_000, "the browser")).resolves.toBe("t_1");
  });

  it("rejects once the work outlives the deadline", async () => {
    const never = new Promise<string>(() => {});
    await expect(withDeadline(never, 10, "the browser")).rejects.toThrow(
      "the browser did not answer within 10ms",
    );
  });

  it("names what stalled, so the log says which side is wedged", async () => {
    const never = new Promise<string>(() => {});
    await expect(withDeadline(never, 5, "tab thr_abc")).rejects.toThrow(/^tab thr_abc did not/);
  });

  it("lets the work's own rejection through unchanged", async () => {
    // A browser that answers "no" must not be reported as a stall.
    const failed = Promise.reject(new Error("Target closed"));
    await expect(withDeadline(failed, 1_000, "the browser")).rejects.toThrow("Target closed");
  });

  it("does not hold the process open after a win", async () => {
    // The timer must be cleared on the happy path too, or every tool call leaks
    // a live 5s timer and bb's event loop pays for it.
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    await withDeadline(Promise.resolve(1), 60_000, "the browser");
    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(after).toBe(before);
  });

  it("guards deadlock rather than latency", () => {
    // A local CDP round trip is sub-millisecond; this only has to beat "never".
    expect(TARGET_ID_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(TARGET_ID_TIMEOUT_MS).toBeLessThan(20_000);
  });
});

// MX-229: `holder:` rows say who last drove a page. They are written by the
// tool/CLI layer and released HERE, because a page that no longer exists must
// not leave an accusation behind for whoever next takes its session key.
describe("the last-driver record's lifetime", () => {
  function fakePage(targetId: string, url: string) {
    let closed = false;
    const page = {
      isClosed: () => closed,
      url: () => url,
      close: async () => {
        closed = true;
      },
      context: () => ({
        newCDPSession: async () => ({
          send: async () => ({ targetInfo: { targetId } }),
          detach: async () => {},
        }),
      }),
    };
    return page as unknown as Parameters<typeof Object.freeze>[0];
  }

  function harness(pages: ReturnType<typeof fakePage>[] = []) {
    const store = new Map<string, unknown>();
    const kv = {
      get: async <T,>(key: string) => store.get(key) as T | undefined,
      set: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
      list: async (prefix?: string) =>
        [...store.keys()].filter((key) => !prefix || key.startsWith(prefix)),
    };
    const browser = async () =>
      ({ contexts: () => [{ pages: () => pages }] }) as unknown as Awaited<
        ReturnType<TabsDeps["browser"]>
      >;
    return { store, tabs: createTabs({ browser, kv, log: () => {} }) };
  }

  it("surfaces who last drove each tab, so `bb browser tabs` can say so", async () => {
    const { store, tabs } = harness([fakePage("t_1", "https://a.example/")]);
    store.set(tabKey("thr_parent"), "t_1");
    store.set(ownedKey("t_1"), true);
    store.set(holderKey("thr_parent"), "thr_worker_b");

    const [row] = await tabs.listTabs();
    expect(row).toMatchObject({ targetId: "t_1", sessionKey: "thr_parent", lastDriver: "thr_worker_b" });
  });

  it("reports no driver for a tab nobody has driven", async () => {
    const { store, tabs } = harness([fakePage("t_1", "https://a.example/")]);
    store.set(tabKey("thr_parent"), "t_1");
    expect((await tabs.listTabs())[0]?.lastDriver).toBeNull();
  });

  it("forgets the driver when the thread's tab is closed", async () => {
    const { store, tabs } = harness([fakePage("t_1", "https://a.example/")]);
    store.set(tabKey("thr_parent"), "t_1");
    store.set(holderKey("thr_parent"), "thr_worker_b");

    await tabs.closeTab("thr_parent");
    expect(store.has(holderKey("thr_parent"))).toBe(false);
  });

  // The reaper's path: it knows a target id and nothing else, so the session key
  // has to be found in reverse. Left behind, this row would tell the next thread
  // to take that key that someone "drove this tab more recently than you did" —
  // about a page reaped half an hour ago.
  it("forgets the driver when a tab is reaped by target id", async () => {
    const { store, tabs } = harness([fakePage("t_1", "https://a.example/")]);
    store.set(tabKey("thr_parent"), "t_1");
    store.set(holderKey("thr_parent"), "thr_worker_b");

    await tabs.closeTarget("t_1");
    expect(store.has(holderKey("thr_parent"))).toBe(false);
  });

  it("leaves another session's driver record alone when reaping one tab", async () => {
    const { store, tabs } = harness([
      fakePage("t_1", "https://a.example/"),
      fakePage("t_2", "https://b.example/"),
    ]);
    store.set(tabKey("thr_one"), "t_1");
    store.set(tabKey("thr_two"), "t_2");
    store.set(holderKey("thr_one"), "thr_worker_a");
    store.set(holderKey("thr_two"), "thr_worker_b");

    await tabs.closeTarget("t_1");
    expect(store.has(holderKey("thr_one"))).toBe(false);
    expect(store.get(holderKey("thr_two"))).toBe("thr_worker_b");
  });
});
