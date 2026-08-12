import { afterEach, describe, expect, it, vi } from "vitest";
import { createPageRegistry } from "./page-registry.js";
import { createPages, TAB_LABEL } from "./pages.js";
import { createReaper, runSweeps } from "./reaper.js";
import { fakeBrowser } from "./test-support/fake-browser.js";
import { fakeCdp, type FakeCdp } from "./test-support/fake-cdp.js";
import { memoryKv } from "./test-support/memory-kv.js";

let server: FakeCdp;
afterEach(async () => { await server?.close(); });

/**
 * `browserCdpUrl` as a spy, not a plain function: several tests below prove
 * a "browser is gone" lookup (`existingPageUrl`, `closePage`) never falls
 * back to it — that's exactly what makes those launch mode, and launching
 * is the bug being fixed. Asserting a call *count* is the only way to prove
 * a call didn't happen, as opposed to merely not asserting on it.
 */
function pagesFor(
  url: string,
  options: { afterRun?: () => void; cdp?: { connectTimeoutMs?: number } } = {},
) {
  const browserCdpUrl = vi.fn(async () => url);
  // A page is created BY the session that will drive it, because only
  // `tab new --label` assigns the label the command path selects by. The
  // fake shares one tab list with the fake browser (`server.targets`), so
  // "the session made a tab" and "the browser has that tab" are the same
  // fact here, exactly as they are in a real browser.
  const browser = fakeBrowser(server);
  const shutdown = vi.fn(async () => {});
  const shutdownAll = vi.fn(async () => {});
  const engine = {
    browserCdpUrl,
    shutdown,
    shutdownAll,
    // `afterRun` fires the instant an invocation returns, which is the only
    // way to land inside the window between `tab new` succeeding and the
    // binding being written.
    run: async (args: Parameters<typeof browser.run>[0]) => {
      const result = await browser.run(args);
      options.afterRun?.();
      return result;
    },
  };
  const kv = memoryKv();
  // The real registry over the same kv — the read-only half is not a thing
  // to stub here, it is half the behaviour under test.
  const registry = createPageRegistry({ kv, log: () => {}, cdp: options.cdp });
  const pages = createPages({ engine, kv, registry, log: () => {}, cdp: options.cdp });
  return { pages, registry, browserCdpUrl, kv, browser, shutdown, shutdownAll };
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

  // agent-browser refuses a second `tab new --label bbpage` outright
  // ("Label `bbpage` is already used by another tab"), and closing the tab is
  // the only thing that frees it. Every path that reaches creation while the
  // session still holds the label on an OPEN tab would otherwise wedge that
  // thread out of ever binding again — only killing its daemon would clear
  // it. There are three such paths, and all three are covered here.
  describe("never wedges a session out of binding", () => {
    it("binds again after a reaper forgets the binding under a live labelled tab", async () => {
      server = await fakeCdp();
      const { pages, browser } = pagesFor(server.url);
      await pages.pageUrlFor("thr_a", "main");
      expect(browser.labelsOf("thr_a")).toEqual([TAB_LABEL]);

      // Exactly what this task's report asks Task 10's reaper to do.
      await pages.forget("thr_a");
      expect(browser.labelsOf("thr_a")).toEqual([TAB_LABEL]);

      const revived = await pages.pageUrlFor("thr_a", "main");
      expect(revived).toMatch(/\/devtools\/page\/tab-2$/);
      // ...and the tab it could not account for is gone, not left labelled
      // and orphaned for the next attempt to trip over.
      expect(server.targets).toHaveLength(1);
    });

    it("binds again after the CDP close of the old page genuinely fails", async () => {
      server = await fakeCdp();
      const { pages } = pagesFor(server.url);
      await pages.pageUrlFor("thr_a", "main");
      server.failOn("Target.closeTarget", "boom");

      await expect(pages.rebind("thr_a", "main")).resolves.toMatchObject({ tab: TAB_LABEL });
      // The old tab survived the failed close, so the reconcile had to be
      // what freed the label — and the thread ends on exactly one page.
      expect(server.targets).toHaveLength(1);
    });

    it("binds again after a create threw between tab new and the binding being written", async () => {
      server = await fakeCdp();
      let breakLookup = false;
      const { pages, kv, browser } = pagesFor(server.url, {
        // Break the marker lookup the moment `tab new` has returned: the tab
        // exists and is labelled, and no binding will be written for it.
        afterRun: () => {
          if (breakLookup) server.failOn("Target.getTargets", "lookup exploded");
        },
      });

      breakLookup = true;
      // Whatever blew up — here the marker lookup itself — propagates.
      await expect(pages.pageUrlFor("thr_a", "main")).rejects.toThrow(/lookup exploded/);
      expect(kv.store.has("page:thr_a")).toBe(false);
      expect(browser.labelsOf("thr_a")).toEqual([TAB_LABEL]);
      expect(server.targets).toHaveLength(1);

      breakLookup = false;
      server.failOn("Target.getTargets", null);
      await expect(pages.pageUrlFor("thr_a", "main")).resolves.toBeTruthy();
      // The orphan was reconciled away rather than left to collide forever.
      expect(server.targets).toHaveLength(1);
    });
  });

  it("coalesces concurrent rebinds instead of racing for the same label", async () => {
    server = await fakeCdp();
    const { pages, browser } = pagesFor(server.url);
    await pages.pageUrlFor("thr_a", "main");

    // Two rebinds at once cannot "each end up on a labelled page of their
    // own": labels are unique per session, so without coalescing the loser
    // gets a hard "already used by another tab" and its command fails.
    const [first, second] = await Promise.all([
      pages.rebind("thr_a", "main"),
      pages.rebind("thr_a", "main"),
    ]);
    expect(second).toEqual(first);
    expect(tabsOpened(browser)).toHaveLength(2);
    expect(server.targets).toHaveLength(1);
  });

  // The ProcessSingleton hazard: a thread session that passes --profile makes
  // Chromium abort on a profile directory another process already holds, and
  // the session is dead for every later command. The create path spawns
  // agent-browser too, and nothing else in the suite watches it.
  it("never launches a browser from the session that creates the page", async () => {
    server = await fakeCdp();
    const { pages, browser } = pagesFor(server.url);
    await pages.pageUrlFor("thr_a", "main");
    await pages.rebind("thr_a", "main");
    expect(browser.calls.length).toBeGreaterThan(0);
    for (const call of browser.calls) expect(call.attach).toBe(true);
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

  // What the reaper reads and acts on. The shared profile restores its tabs
  // when Chromium relaunches (measured, Task 9b: 21 came back), and every
  // restored tab carries a fresh target id no binding names — so "which pages
  // does nobody own" is a question this module has to be able to answer, and
  // to answer without ever launching a browser to find out.
  describe("pages nobody is bound to", () => {
    it("lists every open page and says which session owns each", async () => {
      server = await fakeCdp();
      const { pages } = pagesFor(server.url);
      server.targets.push({ targetId: "restored", type: "page", url: "https://leftover.example/" });
      await pages.pageUrlFor("thr_a", "main");

      const open = await pages.listOpenPages();
      // And which of them this plugin opened. `restored` came back with the
      // browser and belongs to nobody here; `tab-1` is ours. While the
      // browser is headed that difference is the only thing standing between
      // the reaper and the human's login tab.
      expect(open).toEqual([
        { targetId: "restored", url: "https://leftover.example/", sessionKey: null, ours: false },
        { targetId: "tab-1", url: "about:blank", sessionKey: "thr_a", ours: true },
      ]);
    });

    it("lists nothing, and never launches a browser, when none is reachable", async () => {
      server = await fakeCdp();
      const { pages, browserCdpUrl } = pagesFor(server.url);
      await pages.pageUrlFor("thr_a", "main");
      expect(browserCdpUrl).toHaveBeenCalledTimes(1);
      await server.close();

      expect(await pages.listOpenPages()).toEqual([]);
      // The sweep runs every minute forever. If it could launch a browser,
      // this plugin would hold a Chromium open on an idle machine for good.
      expect(browserCdpUrl).toHaveBeenCalledTimes(1);
    });

    // The live case this exists for: bb restarted, every binding is gone, and
    // the browser is still holding 21 tabs from before. With only the
    // bindings to go on there would be no origin left to probe and the debris
    // would be unreachable forever.
    it("still finds the browser when no bindings are left at all", async () => {
      server = await fakeCdp();
      const { pages, kv, browserCdpUrl } = pagesFor(server.url);
      await pages.pageUrlFor("thr_a", "main");
      for (const key of [...kv.store.keys()]) {
        if (key.startsWith("page:")) kv.store.delete(key);
      }

      const open = await pages.listOpenPages();
      // Unowned now — and still recognisably ours, which is the whole reason
      // the record is keyed by target instead of by session: a binding is
      // lost routinely, and a page that loses one has not stopped being a
      // page this plugin opened.
      expect(open).toEqual([
        { targetId: "tab-1", url: "about:blank", sessionKey: null, ours: true },
      ]);
      expect(browserCdpUrl).toHaveBeenCalledTimes(1);
    });

    // The record of which tabs this plugin opened is written per target and
    // never per session, so it survives the binding. That makes it a store
    // that could grow forever — one row per page ever created — which is why
    // every one of these is about it NOT doing that.
    describe("the record of which tabs this plugin opened", () => {
      const createdRows = (kv: { store: Map<string, unknown> }) =>
        [...kv.store.keys()].filter((key) => key.startsWith("created:"));

      it("prunes the row of a tab the browser no longer has", async () => {
        server = await fakeCdp();
        const { pages, kv } = pagesFor(server.url);
        await pages.pageUrlFor("thr_a", "main");
        expect(createdRows(kv)).toEqual(["created:tab-1"]);

        // The tab goes away behind our back — a crash, the panel, a relaunch
        // that minted new ids for everything. Backdated past the grace, since
        // the grace exists only to cover the moments around a create.
        server.targets = [];
        await kv.set("created:tab-1", { profile: "main", at: Date.now() - 10 * 60_000 });

        await pages.listOpenPages();
        expect(createdRows(kv)).toEqual([]);
      });

      // `createPage` opens the tab and writes this row afterwards, so a
      // listing that started before the tab existed must not be allowed to
      // delete the row written after it. Pruning that row would disown a live
      // page permanently — and while headed, "not ours" means "never reaped".
      it("keeps a row younger than the grace period, even with no such tab", async () => {
        server = await fakeCdp();
        const { pages, kv } = pagesFor(server.url);
        await pages.pageUrlFor("thr_a", "main");
        server.targets = [];

        await pages.listOpenPages();
        expect(createdRows(kv)).toEqual(["created:tab-1"]);
      });

      it("prunes nothing at all when no browser of ours is reachable", async () => {
        server = await fakeCdp();
        const { pages, kv } = pagesFor(server.url);
        await pages.pageUrlFor("thr_a", "main");
        await kv.set("created:tab-1", { profile: "main", at: Date.now() - 10 * 60_000 });
        await server.close();

        // An unreachable browser is not evidence that its tabs are gone, and
        // treating it as such would disown every page across a bb restart.
        expect(await pages.listOpenPages()).toEqual([]);
        expect(createdRows(kv)).toEqual(["created:tab-1"]);
      });

      it("drops the row when the session's own page is closed", async () => {
        server = await fakeCdp();
        const { pages, kv } = pagesFor(server.url);
        await pages.pageUrlFor("thr_a", "main");

        await pages.closePage("thr_a");
        expect(createdRows(kv)).toEqual([]);
      });

      it("drops the row when the page is reaped as an orphan", async () => {
        server = await fakeCdp();
        const { pages, kv } = pagesFor(server.url);
        await pages.pageUrlFor("thr_a", "main");
        await pages.forget("thr_a");

        await pages.closeUnboundPage("tab-1");
        expect(createdRows(kv)).toEqual([]);
      });

      // A close that failed leaves the tab OPEN. Dropping the row there would
      // disown a page this plugin made, and the reaper would then decline to
      // try again for as long as the browser is headed.
      it("keeps the row when the close failed and the tab is still open", async () => {
        server = await fakeCdp();
        const { pages, kv } = pagesFor(server.url);
        await pages.pageUrlFor("thr_a", "main");
        await pages.forget("thr_a");
        server.failOn("Target.closeTarget", "boom");

        await expect(pages.closeUnboundPage("tab-1")).rejects.toThrow(/boom/);
        expect(createdRows(kv)).toEqual(["created:tab-1"]);
      });
    });

    it("closes a page nobody is bound to", async () => {
      server = await fakeCdp();
      const { pages } = pagesFor(server.url);
      server.targets.push({ targetId: "restored", type: "page", url: "https://leftover.example/" });
      await pages.pageUrlFor("thr_a", "main");

      await pages.closeUnboundPage("restored");
      expect(server.targets.map((target) => target.targetId)).toEqual(["tab-1"]);
    });

    it("refuses to close a page a binding names", async () => {
      server = await fakeCdp();
      const { pages } = pagesFor(server.url);
      await pages.pageUrlFor("thr_a", "main");

      // The window this closes: a binding written between the sweep's list
      // and its close. Closing here would take a live thread's page away and
      // leave a binding pointing at nothing.
      await expect(pages.closeUnboundPage("tab-1")).rejects.toThrow(/thr_a/);
      expect(server.targets).toHaveLength(1);
    });

    // Reaping must be able to fail visibly: a close that quietly resolves
    // while the tab is still open is how a tab ends up surviving forever with
    // nothing referencing it.
    it("surfaces a failed close instead of swallowing it", async () => {
      server = await fakeCdp();
      const { pages } = pagesFor(server.url);
      server.targets.push({ targetId: "restored", type: "page", url: "https://leftover.example/" });
      await pages.pageUrlFor("thr_a", "main");
      server.failOn("Target.closeTarget", "boom");

      await expect(pages.closeUnboundPage("restored")).rejects.toThrow(/boom/);
      expect(server.targets).toHaveLength(2);
    });

    // The hazard this closes, spelled out: a debugging port is ephemeral and
    // freed the moment its browser exits, and this machine runs OTHER
    // agent-browser Chromiums on ports from the same pool. A reaper that
    // adopted whatever answered at a remembered address would list a
    // stranger's tabs as unowned and close every one of them, once a minute,
    // with nobody watching.
    it("refuses a browser at the remembered address that is not the one we left there", async () => {
      server = await fakeCdp();
      const { pages, kv } = pagesFor(server.url);
      // A tab belonging to whoever owns this browser — the one the reaper
      // would close if it adopted the endpoint.
      server.targets.push({ targetId: "someone-elses", type: "page", url: "https://theirs.example/" });
      await pages.pageUrlFor("thr_a", "main");
      expect(await pages.listOpenPages()).toHaveLength(2);

      // Same host and port, a different browser: exactly what a reused port
      // looks like from the outside.
      server.url = server.url.replace(/\/devtools\/browser\/.*$/, "/devtools/browser/somebody-else");

      expect(await pages.listOpenPages()).toEqual([]);
      // ...and it must not act on it either, however the caller got there.
      await expect(pages.closeUnboundPage("someone-elses")).resolves.toBeUndefined();
      expect(server.targets).toHaveLength(2);
      expect(kv.store.has("origin:main")).toBe(true);
    });

    // Both shapes an identity-less row can take: the bare string written
    // before this check existed, and an object carrying an address and
    // nothing to check it against. Neither may be trusted — an address with
    // no identity is exactly an address that cannot be told from a
    // stranger's, which is the whole hazard.
    it("treats an address remembered without an identity as dead, rather than trusting it", async () => {
      const origin = (url: string) => new URL(url).origin.replace("ws:", "http:");
      for (const legacy of [
        (url: string) => origin(url),
        (url: string) => ({ origin: origin(url) }),
      ]) {
        server = await fakeCdp();
        const { pages, kv } = pagesFor(server.url);
        await pages.pageUrlFor("thr_a", "main");
        expect(await pages.listOpenPages()).toHaveLength(1);

        await kv.set("origin:main", legacy(server.url));
        expect(await pages.listOpenPages()).toEqual([]);
        await server.close();
      }
    });

    it("forgets where the browser was when it shuts the browser down", async () => {
      server = await fakeCdp();
      const { pages, kv, shutdown } = pagesFor(server.url);
      await pages.pageUrlFor("thr_a", "main");
      expect(kv.store.has("origin:main")).toBe(true);

      await pages.shutdownBrowser("main");
      expect(shutdown).toHaveBeenCalledWith("main");
      // The address it left behind names a port that is free again. Keeping
      // it is what lets a stranger's browser be adopted later.
      expect(kv.store.has("origin:main")).toBe(false);
    });

    it("forgets every address when it shuts every browser down", async () => {
      server = await fakeCdp();
      const { pages, kv, shutdownAll } = pagesFor(server.url);
      await pages.pageUrlFor("thr_a", "main");
      await kv.set("origin:other", { origin: "http://127.0.0.1:1", browserId: "x" });

      await pages.shutdownAllBrowsers();
      expect(shutdownAll).toHaveBeenCalled();
      expect([...kv.store.keys()].filter((storedKey) => storedKey.startsWith("origin:"))).toEqual([]);
    });

    it("still forgets the address when the shutdown itself fails", async () => {
      server = await fakeCdp();
      const { pages, kv, shutdown } = pagesFor(server.url);
      await pages.pageUrlFor("thr_a", "main");
      shutdown.mockRejectedValueOnce(new Error("close failed"));

      await expect(pages.shutdownBrowser("main")).rejects.toThrow(/close failed/);
      expect(kv.store.has("origin:main")).toBe(false);
    });

    it("closing an unbound page never launches a browser either", async () => {
      server = await fakeCdp();
      const { pages, browserCdpUrl } = pagesFor(server.url);
      await pages.pageUrlFor("thr_a", "main");
      await server.close();

      await expect(pages.closeUnboundPage("restored")).resolves.toBeUndefined();
      expect(browserCdpUrl).toHaveBeenCalledTimes(1);
    });
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

/**
 * A CDP endpoint that accepts the TCP connection and never completes the
 * websocket handshake — measured on this branch as still-pending at 3s.
 *
 * The reason this has its own block, composed rather than unit, is that
 * `openCdp` hanging is not the interesting failure: a stuck caller is bad,
 * but a hang that never settles poisons things that outlive the call. These
 * are those things.
 */
describe("a CDP connect that never completes", () => {
  /**
   * Short enough that four tests waiting it out cost about a second, long
   * enough that a LEGITIMATE local websocket handshake still fits inside it
   * on a machine under load — an earlier 50ms made these tests fail on a
   * box at load average 31, which is a test defect and not a finding.
   */
  const CONNECT_TIMEOUT_MS = 300;

  async function until(predicate: () => boolean, what: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("rejects the call instead of leaving it pending", async () => {
    server = await fakeCdp();
    const { pages } = pagesFor(server.url, { cdp: { connectTimeoutMs: CONNECT_TIMEOUT_MS } });
    server.holdConnections();
    await expect(pages.pageUrlFor("thr_a", "main")).rejects.toThrow(/connect timed out/);
  }, 8_000);

  // The composed consequence, and the reason this was a Critical rather
  // than an annoyance: `inflight` entries are deleted in a `finally`, so a
  // promise that never settles is never removed — and `bindingFor` hands
  // that same dead promise to every later caller for the session, forever.
  // One thread's unlucky moment becomes its permanent state.
  it("does not leave the session's coalescing entry dead for every later call", async () => {
    server = await fakeCdp();
    const { pages } = pagesFor(server.url, { cdp: { connectTimeoutMs: CONNECT_TIMEOUT_MS } });

    server.holdConnections();
    await expect(pages.pageUrlFor("thr_a", "main")).rejects.toThrow();

    server.allowConnections();
    // The whole point: the same session, immediately afterwards, on a
    // browser that is now answering.
    await expect(pages.pageUrlFor("thr_a", "main")).resolves.toMatch(
      /\/devtools\/page\/tab-1$/,
    );
  }, 8_000);

  it("rejects every caller coalesced onto the hung resolution, not just the first", async () => {
    server = await fakeCdp();
    const { pages } = pagesFor(server.url, { cdp: { connectTimeoutMs: CONNECT_TIMEOUT_MS } });
    server.holdConnections();
    const settled = await Promise.allSettled([
      pages.pageUrlFor("thr_a", "main"),
      pages.pageUrlFor("thr_a", "main"),
    ]);
    expect(settled.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
  }, 8_000);

  // The other composed consequence: `runSweeps` awaits `sweep()`, which
  // awaits `listOpenPages`. A hang there stops the reaper for the plugin's
  // lifetime, and stops it SILENTLY — a hang is not a throw, so neither
  // sweep()'s catch nor runSweeps' catch ever fires, and the only symptom
  // is tabs quietly accumulating forever.
  it("does not stop the reaper's sweep loop for the life of the plugin", async () => {
    server = await fakeCdp();
    const { pages } = pagesFor(server.url, { cdp: { connectTimeoutMs: CONNECT_TIMEOUT_MS } });
    await pages.pageUrlFor("thr_a", "main");

    const listed: string[] = [];
    const warnings: string[] = [];
    const reaper = createReaper({
      idleMs: async () => 60_000,
      graceMs: 60_000,
      headed: async () => false,
      closePage: async () => {},
      // This test is about a hung listing, not about shutdown: a browser
      // whose pages cannot be listed must never be shut down on a guess.
      shutdownBrowser: async () => {
        throw new Error("must not shut down when the listing never resolved");
      },
      shutdownWhenEmpty: async () => false,
      listOpenPages: async () => {
        const open = await pages.listOpenPages();
        listed.push("ok");
        return open;
      },
      closeUnboundPage: async () => {},
      log: () => {},
      warn: (message) => warnings.push(message),
    });

    server.holdConnections();
    const controller = new AbortController();
    const loop = runSweeps(controller.signal, reaper, {
      intervalMs: 10,
      warn: (message) => warnings.push(message),
    });
    try {
      await until(() => warnings.length > 0, "the hung sweep to be reported");
      expect(listed).toEqual([]);

      // A browser that comes back — a relaunch, a machine that woke up.
      server.allowConnections();
      await until(() => listed.length > 0, "a later sweep to succeed");
    } finally {
      controller.abort();
      await loop;
    }
  }, 15_000);
});

// Toggling `headed` closes the browser, which takes every page with it. A
// thread that was working somewhere would otherwise come back to a blank tab
// for a reason that had nothing to do with it.
describe("restoring where a thread was after a relaunch", () => {
  /** Every `open` a session ran, decoded out of the batch payloads. */
  const opened = (browser: { calls: { stdin?: string }[] }) =>
    browser.calls
      .flatMap((call) => JSON.parse(call.stdin ?? "[]") as string[][])
      .filter((argv) => argv[0] === "open")
      .map((argv) => argv[1]);

  it("puts the session's next page back where it was", async () => {
    server = await fakeCdp();
    const { pages, kv, browser } = pagesFor(server.url);
    await pages.pageUrlFor("thr_a", "main");
    server.targets = server.targets.map((target) =>
      target.targetId === "tab-1" ? { ...target, url: "https://example.com/deep" } : target,
    );

    await pages.captureForRestore("main");
    expect(await kv.get("restore:thr_a")).toMatchObject({ url: "https://example.com/deep" });

    // The relaunch: the browser is gone, so the next command creates a page.
    server.targets = [];
    await pages.pageUrlFor("thr_a", "main");
    expect(opened(browser)).toContain("https://example.com/deep");
    // Used once and dropped, so it cannot fire again later.
    expect(await kv.get("restore:thr_a")).toBeUndefined();
  });

  it("does not restore a capture that has gone stale", async () => {
    server = await fakeCdp();
    const { pages, kv, browser } = pagesFor(server.url);
    await kv.set("restore:thr_a", {
      profile: "main",
      url: "https://example.com/old",
      at: Date.now() - 60 * 60_000,
    });
    await pages.pageUrlFor("thr_a", "main");
    expect(opened(browser)).not.toContain("https://example.com/old");
    expect(await kv.get("restore:thr_a")).toBeUndefined();
  });

  it("captures nothing for a tab no thread is bound to", async () => {
    server = await fakeCdp();
    const { pages, kv } = pagesFor(server.url);
    // A bound page first: without one there is no remembered browser address,
    // so the listing comes back empty and this would pass without reaching
    // the rule it is meant to check.
    await pages.pageUrlFor("thr_a", "main");
    server.targets = [
      ...server.targets.map((target) =>
        target.targetId === "tab-1" ? { ...target, url: "https://example.com/mine" } : target,
      ),
      { targetId: "someone-elses", type: "page", url: "https://example.org/" },
    ];

    await pages.captureForRestore("main");
    // The human's tab is not a thread's page to put back.
    expect(await kv.list("restore:")).toEqual(["restore:thr_a"]);
  });

  it("captures nothing for a page that is not on a real destination", async () => {
    server = await fakeCdp();
    const { pages, kv } = pagesFor(server.url);
    await pages.pageUrlFor("thr_a", "main");
    // Left on the create marker: restoring a blank tab is just a blank tab,
    // with a stale record left behind to expire.
    await pages.captureForRestore("main");
    expect(await kv.list("restore:")).toEqual([]);
  });
});
