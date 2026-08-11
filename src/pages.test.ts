import { afterEach, describe, expect, it, vi } from "vitest";
import { createPages } from "./pages.js";
import { fakeCdp, type FakeCdp } from "./test-support/fake-cdp.js";

let server: FakeCdp;
afterEach(async () => { await server?.close(); });

function memoryKv() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async <T,>(key: string) => store.get(key) as T | undefined,
    set: async (key: string, value: unknown) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
  };
}

/**
 * `browserCdpUrl` as a spy, not a plain function: several tests below prove
 * a "browser is gone" lookup (`existingPageUrl`, `closePage`) never falls
 * back to it — that's exactly what makes those launch mode, and launching
 * is the bug being fixed. Asserting a call *count* is the only way to prove
 * a call didn't happen, as opposed to merely not asserting on it.
 */
function pagesFor(url: string) {
  const browserCdpUrl = vi.fn(async () => url);
  // Only what PagesDeps.engine actually declares (Pick<Engine,
  // "browserCdpUrl">) — pages.ts never calls anything else on it.
  const engine = { browserCdpUrl };
  const kv = memoryKv();
  const pages = createPages({ engine, kv, log: () => {} });
  return { pages, browserCdpUrl, kv };
}

describe("pages", () => {
  it("creates a page and returns its own websocket", async () => {
    server = await fakeCdp();
    const { pages } = pagesFor(server.url);
    const pageUrl = await pages.pageUrlFor("thr_a", "main");
    expect(pageUrl).toMatch(/\/devtools\/page\/page-1$/);
    expect(server.received.some((m) => m.method === "Target.createTarget")).toBe(true);
  });

  it("reuses the same page for the same session", async () => {
    server = await fakeCdp();
    const { pages } = pagesFor(server.url);
    const first = await pages.pageUrlFor("thr_a", "main");
    const second = await pages.pageUrlFor("thr_a", "main");
    expect(second).toBe(first);
    expect(server.received.filter((m) => m.method === "Target.createTarget")).toHaveLength(1);
  });

  it("gives two sessions two different pages", async () => {
    server = await fakeCdp();
    const { pages } = pagesFor(server.url);
    const a = await pages.pageUrlFor("thr_a", "main");
    const b = await pages.pageUrlFor("thr_b", "main");
    expect(a).not.toBe(b);
  });

  it("recreates a page the user closed behind our back", async () => {
    server = await fakeCdp();
    const { pages } = pagesFor(server.url);
    await pages.pageUrlFor("thr_a", "main");
    server.targets = [];
    const revived = await pages.pageUrlFor("thr_a", "main");
    expect(revived).toMatch(/\/devtools\/page\/page-2$/);
  });

  it("closes a page through CDP, because detaching leaves it alive", async () => {
    server = await fakeCdp();
    const { pages } = pagesFor(server.url);
    await pages.pageUrlFor("thr_a", "main");
    await pages.closePage("thr_a");
    expect(server.received.some((m) => m.method === "Target.closeTarget")).toBe(true);
    expect(server.targets).toHaveLength(0);
  });

  it("coalesces concurrent pageUrlFor calls for the same session key into one page", async () => {
    server = await fakeCdp();
    const { pages } = pagesFor(server.url);
    const [a, b] = await Promise.all([
      pages.pageUrlFor("thr_a", "main"),
      pages.pageUrlFor("thr_a", "main"),
    ]);
    expect(a).toBe(b);
    expect(server.received.filter((m) => m.method === "Target.createTarget")).toHaveLength(1);
    // The binding must point at the one page both callers were handed —
    // otherwise a later closePage would close a page nobody was told about.
    await pages.closePage("thr_a");
    expect(server.targets).toHaveLength(0);
  });

  it("existingPageUrl returns null and touches nothing when no page was ever opened", async () => {
    server = await fakeCdp();
    const { pages } = pagesFor(server.url);
    const url = await pages.existingPageUrl("thr_never_opened");
    expect(url).toBeNull();
    // The whole point: a viewer asking about a session nobody drove yet must
    // never be the reason a page gets created.
    expect(server.received.some((m) => m.method === "Target.createTarget")).toBe(false);
  });

  it("existingPageUrl returns the bound page's url when it is still open", async () => {
    server = await fakeCdp();
    const { pages } = pagesFor(server.url);
    const created = await pages.pageUrlFor("thr_a", "main");
    const found = await pages.existingPageUrl("thr_a");
    expect(found).toBe(created);
    // Only the one create from pageUrlFor above — the lookup itself must
    // never create a second page.
    expect(server.received.filter((m) => m.method === "Target.createTarget")).toHaveLength(1);
  });

  it("existingPageUrl returns null, and does not create, when the bound target vanished", async () => {
    server = await fakeCdp();
    const { pages } = pagesFor(server.url);
    await pages.pageUrlFor("thr_a", "main");
    server.targets = [];
    const found = await pages.existingPageUrl("thr_a");
    expect(found).toBeNull();
    expect(server.received.filter((m) => m.method === "Target.createTarget")).toHaveLength(1);
  });

  it("closePage clears the binding even when Target.closeTarget errors", async () => {
    server = await fakeCdp();
    const { pages } = pagesFor(server.url);
    await pages.pageUrlFor("thr_a", "main");
    // Simulate the page having already vanished by the time we try to close it.
    server.targets = [];
    await pages.closePage("thr_a");
    // A second close must be a no-op, not an error — proving the binding was cleared.
    await expect(pages.closePage("thr_a")).resolves.toBeUndefined();
    // And calling pageUrlFor again must create a fresh page rather than
    // reusing a stale, already-cleared binding forever.
    const revived = await pages.pageUrlFor("thr_a", "main");
    expect(server.received.filter((m) => m.method === "Target.createTarget")).toHaveLength(2);
    expect(revived).toBeTruthy();
  });

  // The bug this whole block regression-tests: a viewer must never be able
  // to start a browser process just by asking whether one is running.
  // `browserCdpUrl` is launch mode (agent-browser's "get cdp-url" starts
  // Chromium if none is up), so the assertion that matters is not just
  // "returned null" but "never called it at all" — call-count zero *beyond*
  // the one legitimate call `pageUrlFor` made to create the page.
  describe("never launches to answer a read-only question", () => {
    it("existingPageUrl returns null with no further engine calls once the browser process is gone", async () => {
      server = await fakeCdp();
      const { pages, browserCdpUrl } = pagesFor(server.url);
      await pages.pageUrlFor("thr_a", "main");
      expect(browserCdpUrl).toHaveBeenCalledTimes(1);

      // Kill the whole process, not just its targets — this closes both the
      // WS upgrade handler and the /json/version HTTP endpoint the probe
      // depends on, standing in for a machine that rebooted or a Chromium
      // that crashed since the binding was written.
      await server.close();

      const found = await pages.existingPageUrl("thr_a");
      expect(found).toBeNull();
      expect(browserCdpUrl).toHaveBeenCalledTimes(1);
    });

    it("closePage on an unreachable browser clears the binding and calls nothing", async () => {
      server = await fakeCdp();
      const { pages, browserCdpUrl, kv } = pagesFor(server.url);
      await pages.pageUrlFor("thr_a", "main");
      expect(browserCdpUrl).toHaveBeenCalledTimes(1);
      expect(kv.store.has("page:thr_a")).toBe(true);

      await server.close();

      await expect(pages.closePage("thr_a")).resolves.toBeUndefined();
      expect(browserCdpUrl).toHaveBeenCalledTimes(1);
      // Not just "didn't throw" — the binding itself must be gone, or a
      // later existingPageUrl would keep probing a dead origin forever.
      expect(kv.store.has("page:thr_a")).toBe(false);
    });

    it("treats a pre-origin binding (written before this field existed) as unreachable, never as a reason to call browserCdpUrl", async () => {
      server = await fakeCdp();
      const { pages, browserCdpUrl, kv } = pagesFor(server.url);
      // Simulates a row on disk from before this fix: same shape, no `origin`.
      await kv.set("page:thr_old", { profile: "main", targetId: "page-old" });

      const found = await pages.existingPageUrl("thr_old");
      expect(found).toBeNull();
      expect(browserCdpUrl).not.toHaveBeenCalled();

      await expect(pages.closePage("thr_old")).resolves.toBeUndefined();
      expect(browserCdpUrl).not.toHaveBeenCalled();
      expect(kv.store.has("page:thr_old")).toBe(false);
    });

    it("pageUrlFor still launches and creates exactly as before, unaffected by the read-only paths", async () => {
      server = await fakeCdp();
      const { pages, browserCdpUrl } = pagesFor(server.url);
      const url = await pages.pageUrlFor("thr_a", "main");
      expect(url).toMatch(/\/devtools\/page\/page-1$/);
      // The one path that's allowed to launch still does.
      expect(browserCdpUrl).toHaveBeenCalledTimes(1);
      expect(server.received.some((m) => m.method === "Target.createTarget")).toBe(true);
    });
  });
});
