import { describe, expect, it } from "vitest";
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

// MX-1080: each thread has its own tab, so a thread's teardown closes that
// tab and no other — above all not its operator's, which a spawned worker
// used to share.
describe("closing one thread's tab", () => {
  it("closes the worker's tab and leaves the operator's open", async () => {
    const operatorPage = fakePage("t_op", "https://a.example/");
    const workerPage = fakePage("t_w", "https://b.example/");
    const { store, tabs } = harness([operatorPage, workerPage]);
    store.set(tabKey("thr_operator"), "t_op");
    store.set(tabKey("thr_worker"), "t_w");

    await tabs.closeTab("thr_worker");
    expect((workerPage as unknown as { isClosed(): boolean }).isClosed()).toBe(true);
    expect((operatorPage as unknown as { isClosed(): boolean }).isClosed()).toBe(false);
    expect(store.get(tabKey("thr_operator"))).toBe("t_op");
    expect(store.has(tabKey("thr_worker"))).toBe(false);
  });
});

// ADOPTION (MX-306). A mode switch is a relaunch, and Chromium session-restores
// the profile's pages — so the agent's page is already back, with a new target
// id that no binding names. Adoption is how it stops being an orphan; the
// decision about WHICH page is adoptable is the mode switch's, because it needs
// the picture from before the relaunch.
describe("adopting a page the browser restored", () => {
  it("binds the page to the thread, so tabFor finds it again", async () => {
    const { store, tabs } = harness([fakePage("t_new", "https://a.example/")]);
    // The pre-relaunch binding, pointing at a target id that died with the
    // old process.
    store.set(tabKey("thr_a"), "t_dead");

    await tabs.adopt("thr_a", "t_new");

    expect(store.get(tabKey("thr_a"))).toBe("t_new");
    expect((await tabs.tabFor("thr_a")).targetId).toBe("t_new");
  });

  // The half that is easy to leave out and impossible to see afterwards: an
  // adopted page with no ownership record is precisely the unreapable orphan
  // this fix exists to stop making, arrived at from the other direction.
  it("records the page as ours, so the reaper may eventually close it", async () => {
    const { store, tabs } = harness([fakePage("t_new", "https://a.example/")]);
    await tabs.adopt("thr_a", "t_new");
    expect(store.get(ownedKey("t_new"))).toBe(true);
    expect((await tabs.listTabs())[0]).toMatchObject({ ours: true, sessionKey: "thr_a" });
  });
});
