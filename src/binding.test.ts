// The test that would have caught the binding defect.
//
// The earlier check could not: it named the first tab of a two-tab browser,
// so "honours the tab it was told" and "always lands on some other tab"
// predicted the same answer. Everything here is built so those two give
// DIFFERENT answers — three or more tabs, a decoy that predates both
// threads, and assertions on the browser's own tab list rather than on what
// each session says about itself.
import { afterEach, describe, expect, it } from "vitest";
import { createOperations } from "./operations.js";
import { createPages, type Pages } from "./pages.js";
import { fakeBrowser, type FakeBrowser } from "./test-support/fake-browser.js";
import { fakeCdp, type FakeCdp } from "./test-support/fake-cdp.js";

let server: FakeCdp;
afterEach(async () => {
  await server?.close();
});

function memoryKv() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async <T,>(key: string) => store.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

async function stack() {
  server = await fakeCdp();
  // A decoy tab that predates both threads. With it, "picks the oldest",
  // "picks the newest" and "picks the one this thread is bound to" are three
  // different answers, and only the third one passes.
  server.targets.push({ targetId: "decoy", type: "page", url: "https://decoy.example/" });
  const browser = fakeBrowser(server);
  const engine = {
    browserCdpUrl: async () => server.url,
    run: browser.run,
    shutdown: async () => {},
    shutdownAll: async () => {},
  };
  const kv = memoryKv();
  const pages: Pages = createPages({ engine, kv, log: () => {} });
  const operations = createOperations({ engine, pages, profileFor: async () => "main" });
  return { browser, kv, pages, operations };
}

const boundTarget = (kv: { store: Map<string, unknown> }, sessionKey: string) =>
  (kv.store.get(`page:${sessionKey}`) as { targetId: string } | undefined)?.targetId;

const urlOf = (targetId: string | undefined) =>
  server.targets.find((target) => target.targetId === targetId)?.url;

describe("two threads in one browser", () => {
  it("gives each thread its own page and never moves another thread's", async () => {
    const { operations, kv } = await stack();

    await operations.open("thr_a", "https://a.example/");
    await operations.open("thr_b", "https://b.example/");

    const a = boundTarget(kv, "thr_a");
    const b = boundTarget(kv, "thr_b");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    // Three tabs, so this cannot be satisfied by accident.
    expect(server.targets.length).toBeGreaterThanOrEqual(3);

    // Asserted on the browser's tabs, not on what either session reports.
    expect(urlOf(a)).toBe("https://a.example/");
    expect(urlOf(b)).toBe("https://b.example/");
    expect(urlOf("decoy")).toBe("https://decoy.example/");

    // ...and the other way round: driving A leaves B where it was.
    await operations.open("thr_a", "https://a2.example/");
    expect(urlOf(a)).toBe("https://a2.example/");
    expect(urlOf(b)).toBe("https://b.example/");

    // ...and driving B leaves A where it was.
    await operations.open("thr_b", "https://b2.example/");
    expect(urlOf(b)).toBe("https://b2.example/");
    expect(urlOf(a)).toBe("https://a2.example/");
  });

  it("reports each thread's own page back to that thread", async () => {
    const { operations } = await stack();
    await operations.open("thr_a", "https://a.example/");
    await operations.open("thr_b", "https://b.example/");

    expect(await operations.evaluate("thr_a", "location.href")).toContain("a.example");
    expect(await operations.read("thr_a")).toBe("text of https://a.example/");
    expect(await operations.read("thr_b")).toBe("text of https://b.example/");
    // Interleaved, because a per-session pointer that only survives while
    // nobody else is talking is not a binding.
    expect(await operations.read("thr_a")).toBe("text of https://a.example/");
  });

  it("a third thread opening a page does not move the first two", async () => {
    const { operations, kv } = await stack();
    await operations.open("thr_a", "https://a.example/");
    await operations.open("thr_b", "https://b.example/");
    const a = boundTarget(kv, "thr_a");
    const b = boundTarget(kv, "thr_b");

    await operations.open("thr_c", "https://c.example/");

    expect(urlOf(a)).toBe("https://a.example/");
    expect(urlOf(b)).toBe("https://b.example/");
    expect(urlOf(boundTarget(kv, "thr_c"))).toBe("https://c.example/");
  });

  it("recovers on its own when the session's daemon dies under it", async () => {
    const { operations, browser, kv } = await stack();
    await operations.open("thr_a", "https://a.example/");
    await operations.open("thr_b", "https://b.example/");
    const b = boundTarget(kv, "thr_b");

    // The daemon is per session (measured: one <session>.pid per session in
    // the namespace's run dir). Killing thr_a's loses its labels while the
    // browser, and every tab in it, keeps running.
    browser.killDaemon("thr_a");

    await expect(operations.open("thr_a", "https://a3.example/")).resolves.toBeTruthy();
    expect(urlOf(boundTarget(kv, "thr_a"))).toBe("https://a3.example/");
    // Recovery is thr_a's business alone.
    expect(urlOf(b)).toBe("https://b.example/");
    // ...and it must not leave its old tab behind as an orphan nobody owns.
    expect(server.targets.filter((target) => target.url.startsWith("https://a")).length).toBe(1);
  });
});
