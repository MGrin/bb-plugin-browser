import { afterEach, describe, expect, it, vi } from "vitest";
import { createPages, TAB_LABEL } from "./pages.js";
import { fakeBrowser } from "./test-support/fake-browser.js";
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
  // A page is created BY the session that will drive it, because only
  // `tab new --label` assigns the label the command path selects by. The
  // fake shares one tab list with the fake browser (`server.targets`), so
  // "the session made a tab" and "the browser has that tab" are the same
  // fact here, exactly as they are in a real browser.
  const browser = fakeBrowser(server);
  const engine = { browserCdpUrl, run: browser.run };
  const kv = memoryKv();
  const pages = createPages({ engine, kv, log: () => {} });
  return { pages, browserCdpUrl, kv, browser };
}

/** Every `tab new` the sessions ran, decoded out of the batch payloads. */
const tabsOpened = (browser: { calls: { stdin?: string }[] }) =>
  browser.calls
    .flatMap((call) => JSON.parse(call.stdin ?? "[]") as string[][])
    .filter((argv) => argv[0] === "tab" && argv[1] === "new");

describe("pages", () => {
  it("creates a page and returns its own websocket", async () => {
    server = await fakeCdp();
    const { pages, browser } = pagesFor(server.url);
    const pageUrl = await pages.pageUrlFor("thr_a", "main");
    expect(pageUrl).toMatch(/\/devtools\/page\/tab-1$/);
    // Created with a label, or no session could ever point itself at it
    // again: `connect` ignores the page it is handed, and a bare t<N> ref is
    // a per-session index that means a different tab in a different session.
    expect(tabsOpened(browser)).toEqual([["tab", "new", "--label", TAB_LABEL, expect.any(String)]]);
  });

  it("reuses the same page for the same session", async () => {
    server = await fakeCdp();
    const { pages, browser } = pagesFor(server.url);
    const first = await pages.pageUrlFor("thr_a", "main");
    const second = await pages.pageUrlFor("thr_a", "main");
    expect(second).toBe(first);
    expect(tabsOpened(browser)).toHaveLength(1);
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
    expect(revived).toMatch(/\/devtools\/page\/tab-2$/);
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
    const { pages, browser } = pagesFor(server.url);
    const [a, b] = await Promise.all([
      pages.pageUrlFor("thr_a", "main"),
      pages.pageUrlFor("thr_a", "main"),
    ]);
    expect(a).toBe(b);
    expect(tabsOpened(browser)).toHaveLength(1);
    // The binding must point at the one page both callers were handed —
    // otherwise a later closePage would close a page nobody was told about.
    await pages.closePage("thr_a");
    expect(server.targets).toHaveLength(0);
  });

  it("existingPageUrl returns null and touches nothing when no page was ever opened", async () => {
    server = await fakeCdp();
    const { pages, browser } = pagesFor(server.url);
    const url = await pages.existingPageUrl("thr_never_opened");
    expect(url).toBeNull();
    // The whole point: a viewer asking about a session nobody drove yet must
    // never be the reason a page gets created.
    expect(tabsOpened(browser)).toHaveLength(0);
  });

  it("existingPageUrl returns the bound page's url when it is still open", async () => {
    server = await fakeCdp();
    const { pages, browser } = pagesFor(server.url);
    const created = await pages.pageUrlFor("thr_a", "main");
    const found = await pages.existingPageUrl("thr_a");
    expect(found).toBe(created);
    // Only the one create from pageUrlFor above — the lookup itself must
    // never create a second page.
    expect(tabsOpened(browser)).toHaveLength(1);
  });

  it("existingPageUrl returns null, and does not create, when the bound target vanished", async () => {
    server = await fakeCdp();
    const { pages, browser } = pagesFor(server.url);
    await pages.pageUrlFor("thr_a", "main");
    server.targets = [];
    const found = await pages.existingPageUrl("thr_a");
    expect(found).toBeNull();
    expect(tabsOpened(browser)).toHaveLength(1);
  });

  it("existingPageInfo reports the page's current document url without creating one", async () => {
    server = await fakeCdp();
    const { pages, browser } = pagesFor(server.url);
    const created = await pages.pageUrlFor("thr_a", "main");
    server.targets[0]!.url = "https://example.com/";

    const info = await pages.existingPageInfo("thr_a");
    expect(info).toEqual({ cdpUrl: created, url: "https://example.com/" });
    // The panel calls this on every mount to fill its address bar. Doing so
    // must never be the reason a page exists.
    expect(tabsOpened(browser)).toHaveLength(1);
  });

  it("reports a freshly created page as about:blank, not as its internal marker", async () => {
    server = await fakeCdp();
    const { pages } = pagesFor(server.url);
    await pages.pageUrlFor("thr_a", "main");
    // The tab really is at about:blank#bb-xxxxxxxx — that fragment is how
    // the target was picked out of the browser's target list — but it is not
    // where the user's page "is", and the panel's address bar shows this.
    expect(server.targets[0]!.url).toMatch(/^about:blank#bb-[0-9a-f]{8}$/);
    expect((await pages.existingPageInfo("thr_a"))?.url).toBe("about:blank");
  });

  it("existingPageInfo returns null when nothing is bound", async () => {
    server = await fakeCdp();
    const { pages, browser } = pagesFor(server.url);
    expect(await pages.existingPageInfo("thr_never_opened")).toBeNull();
    expect(tabsOpened(browser)).toHaveLength(0);
  });

  // Task 9b: what a binding has to carry changed. A row written before it
  // names a tab that carries no label in any session — nothing can ever
  // select that tab again, so handing it back would leave the thread driving
  // whatever tab its session happened to land on.
  it("replaces a pre-9b binding whose tab can no longer be selected", async () => {
    server = await fakeCdp();
    const { pages, kv } = pagesFor(server.url);
    server.targets.push({ targetId: "old-tab", type: "page", url: "https://old.example/" });
    await kv.set("page:thr_a", {
      profile: "main",
      targetId: "old-tab",
      origin: new URL(server.url).origin.replace("ws:", "http:"),
    });

    const url = await pages.pageUrlFor("thr_a", "main");
    expect(url).toMatch(/\/devtools\/page\/tab-1$/);
    expect((kv.store.get("page:thr_a") as { tab?: string }).tab).toBe(TAB_LABEL);
    // ...and the page it walked away from is closed, not left as an orphan
    // tab nobody owns and nothing will ever close.
    expect(server.targets.some((target) => target.targetId === "old-tab")).toBe(false);
  });

  it("rebind swaps in a fresh, freshly labelled page and closes the old one", async () => {
    server = await fakeCdp();
    const { pages, kv, browser } = pagesFor(server.url);
    const first = await pages.pageUrlFor("thr_a", "main");

    const second = await pages.rebind("thr_a", "main");

    expect(second.cdpUrl).not.toBe(first);
    expect(second.tab).toBe(TAB_LABEL);
    expect(tabsOpened(browser)).toHaveLength(2);
    expect(server.targets).toHaveLength(1);
    expect((kv.store.get("page:thr_a") as { targetId: string }).targetId).toBe("tab-2");
  });

  it("closePage clears the binding even when Target.closeTarget errors", async () => {
    server = await fakeCdp();
    const { pages, browser } = pagesFor(server.url);
    await pages.pageUrlFor("thr_a", "main");
    // Simulate the page having already vanished by the time we try to close it.
    server.targets = [];
    await pages.closePage("thr_a");
    // A second close must be a no-op, not an error — proving the binding was cleared.
    await expect(pages.closePage("thr_a")).resolves.toBeUndefined();
    // And calling pageUrlFor again must create a fresh page rather than
    // reusing a stale, already-cleared binding forever.
    const revived = await pages.pageUrlFor("thr_a", "main");
    expect(tabsOpened(browser)).toHaveLength(2);
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
      const { pages, browserCdpUrl, browser } = pagesFor(server.url);
      const url = await pages.pageUrlFor("thr_a", "main");
      expect(url).toMatch(/\/devtools\/page\/tab-1$/);
      // The one path that's allowed to launch still does.
      expect(browserCdpUrl).toHaveBeenCalledTimes(1);
      expect(tabsOpened(browser)).toHaveLength(1);
    });
  });
});
