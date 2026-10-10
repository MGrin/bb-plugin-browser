import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActions } from "./actions.js";
import { quit } from "./launch.js";
import type { TabsDeps } from "./tabs.js";
import { createTabs, tabKey } from "./tabs.js";

// MX-1440. Four Playwright calls this plugin makes carry NO timeout of their
// own — `context.newPage()`, `page.title()`, `page.evaluate()` and
// `page.close()` all go out with `kNoTimeout` in playwright-core 1.62.1, and
// `page.setDefaultTimeout` reaches none of them — and `quit` waited on a
// DevTools socket with no bound either. Any one of them that never answers
// left the caller waiting forever with no output at all. Each test below
// stands in a call that never answers and requires an error with text that
// names the call, instead of a promise that never settles.

/** Longer than every bound in the plugin. Base had no bound, so it stays pending. */
const PAST_EVERY_BOUND_MS = 120_000;

const never = <T,>() => new Promise<T>(() => {});

/** Settle-state of a promise, readable without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state: { status: "pending" | "resolved" | "rejected"; error?: Error } = {
    status: "pending",
  };
  promise.then(
    () => void (state.status = "resolved"),
    (error: Error) => {
      state.status = "rejected";
      state.error = error;
    },
  );
  return state;
}

function fakeStore() {
  const store = new Map<string, unknown>();
  return {
    store,
    kv: {
      get: async <T,>(key: string) => store.get(key) as T | undefined,
      set: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
      list: async (prefix?: string) =>
        [...store.keys()].filter((key) => !prefix || key.startsWith(prefix)),
    },
  };
}

function fakePage(targetId: string, overrides: Record<string, unknown> = {}) {
  let closed = false;
  return {
    isClosed: () => closed,
    url: () => "about:blank",
    close: async () => {
      closed = true;
    },
    setDefaultTimeout: () => {},
    context: () => ({
      newCDPSession: async () => ({
        send: async () => ({ targetInfo: { targetId } }),
        detach: async () => {},
      }),
    }),
    ...overrides,
  };
}

function tabsWith(newPage: () => Promise<unknown>, pages: unknown[] = []) {
  const { store, kv } = fakeStore();
  const browser = async () =>
    ({ contexts: () => [{ pages: () => pages, newPage }] }) as unknown as Awaited<
      ReturnType<TabsDeps["browser"]>
    >;
  return { store, tabs: createTabs({ browser, kv, log: () => {} }) };
}

const activity = { touch() {}, watch() {}, unwatch() {}, forget() {} };

describe("a call that never answers becomes an error naming it (MX-1440)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tabFor: the browser never opens the new tab", async () => {
    vi.useFakeTimers();
    const { tabs } = tabsWith(() => never());
    const call = track(tabs.tabFor("thr_new"));
    await vi.advanceTimersByTimeAsync(PAST_EVERY_BOUND_MS);
    expect(call.status).toBe("rejected");
    expect(call.error?.message).toMatch(/context\.newPage/);
    expect(call.error?.message).toMatch(/thr_new/);
  });

  it("tabFor: a tab that arrives after the deadline is closed, never bound", async () => {
    // Nothing holds it and nothing recorded it as ours, so the reaper could
    // never prove it may close it: closing it here is the only chance.
    vi.useFakeTimers();
    let arrive: (page: unknown) => void = () => {};
    const late = fakePage("t_late");
    const { store, tabs } = tabsWith(() => new Promise((resolve) => (arrive = resolve)));
    const call = track(tabs.tabFor("thr_new"));
    await vi.advanceTimersByTimeAsync(PAST_EVERY_BOUND_MS);
    expect(call.status).toBe("rejected");
    arrive(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.isClosed()).toBe(true);
    expect(store.has(tabKey("thr_new"))).toBe(false);
  });

  it("open: the page never reports its title", async () => {
    vi.useFakeTimers();
    const page = fakePage("t_1", { goto: async () => null, title: () => never() });
    const actions = createActions({
      tabs: { tabFor: async () => ({ page, targetId: "t_1" }), closeTab: async () => {} } as never,
      activity,
    });
    const call = track(actions.open("thr_a", "https://example.com/"));
    await vi.advanceTimersByTimeAsync(PAST_EVERY_BOUND_MS);
    expect(call.status).toBe("rejected");
    expect(call.error?.message).toMatch(/page\.title/);
  });

  it("eval: an expression that never settles", async () => {
    vi.useFakeTimers();
    const page = fakePage("t_1", { evaluate: () => never() });
    const actions = createActions({
      tabs: { tabFor: async () => ({ page, targetId: "t_1" }), closeTab: async () => {} } as never,
      activity,
    });
    const call = track(actions.evaluate("thr_a", "new Promise(() => {})"));
    await vi.advanceTimersByTimeAsync(PAST_EVERY_BOUND_MS);
    expect(call.status).toBe("rejected");
    expect(call.error?.message).toMatch(/page\.evaluate/);
  });

  it("close: the browser never closes the tab", async () => {
    vi.useFakeTimers();
    const page = fakePage("t_w", { close: () => never() });
    const { store, tabs } = tabsWith(() => never(), [page]);
    store.set(tabKey("thr_w"), "t_w");
    const call = track(tabs.closeTab("thr_w"));
    await vi.advanceTimersByTimeAsync(PAST_EVERY_BOUND_MS);
    expect(call.status).toBe("rejected");
    expect(call.error?.message).toMatch(/page\.close/);
  });

  // The scenario MX-1440 was filed under: one thread's tab busy, another
  // opening its first. NOT a reproduction — it passed on base too, and a real
  // Chromium measured the same (newPage in 53-166 ms beside a CPU-bound tab, a
  // hung navigation and an open alert()). Kept so nothing ever serialises the
  // threads behind one another's tabs.
  it("one thread's endless action does not hold up another thread's first tab", async () => {
    const busy = fakePage("t_a", { evaluate: () => never() });
    const fresh = fakePage("t_b");
    const pages: unknown[] = [busy];
    const { store, tabs } = tabsWith(async () => {
      pages.push(fresh);
      return fresh;
    }, pages);
    store.set(tabKey("thr_a"), "t_a");
    const actions = createActions({ tabs, activity });
    void actions.evaluate("thr_a", "new Promise(() => {})").catch(() => {});
    await expect(tabs.tabFor("thr_b")).resolves.toMatchObject({ targetId: "t_b" });
  });
});

describe("quit bounds the DevTools socket (MX-1440)", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  it("errors, naming the socket, when the WebSocket upgrade is never answered", async () => {
    // Answers /json/version like a browser, then accepts the upgrade and never
    // completes it — what a wedged browser looks like from here.
    server = createServer((request, response) => {
      const { port } = server!.address() as AddressInfo;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }),
      );
    });
    server.on("upgrade", () => {});
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const profileDir = await mkdtemp(join(tmpdir(), "mx1440-"));
    await writeFile(join(profileDir, "DevToolsActivePort"), `${port}\n/devtools/browser/x\n`);

    const call = track(quit(profileDir, 200));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(call.status).toBe("rejected");
    expect(call.error?.message).toMatch(/DevTools socket/);
  });
});
