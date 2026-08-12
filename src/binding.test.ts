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
import { createPageRegistry } from "./page-registry.js";
import { createPages, type Pages } from "./pages.js";
import { createReaper } from "./reaper.js";
import {
  fakeBrowser,
  landOnNewest,
  landOnOldest,
  type Landing,
} from "./test-support/fake-browser.js";
import { fakeCdp, type FakeCdp } from "./test-support/fake-cdp.js";
import { memoryKv } from "./test-support/memory-kv.js";

let server: FakeCdp;
afterEach(async () => {
  await server?.close();
});

async function stack(land: Landing = landOnNewest) {
  server = await fakeCdp();
  // A decoy tab that predates both threads. With it, "picks the oldest",
  // "picks the newest" and "picks the one this thread is bound to" are three
  // different answers, and only the third one passes. `land` varies which
  // wrong answer a connect would give, so no test can pass by coinciding
  // with one particular one.
  server.targets.push({ targetId: "decoy", type: "page", url: "https://decoy.example/" });
  const browser = fakeBrowser(server, { land });
  const engine = {
    browserCdpUrl: async () => server.url,
    run: browser.run,
    shutdown: async () => {},
    shutdownAll: async () => {},
  };
  const kv = memoryKv();
  const registry = createPageRegistry({ kv, log: () => {} });
  const pages: Pages = createPages({ engine, kv, registry, log: () => {} });
  // The real reaper over the real Pages, not a stand-in: whether a sweep
  // actually removes a tab from the browser is the only question worth
  // asking about it, and a stubbed closePage cannot answer it.
  const idle = { ms: 1000 };
  const reaper = createReaper({
    idleMs: async () => idle.ms,
    graceMs: 500,
    headed: async () => false,
    // A no-op rather than a real shutdown: these tests drive the binding
    // mechanism against one live fake browser, and a sweep that empties it
    // must not take the browser out from under the next assertion.
    shutdownBrowser: async () => {},
    closePage: (sessionKey) => registry.closePage(sessionKey),
    listOpenPages: () => registry.listOpenPages(),
    closeUnboundPage: (targetId) => registry.closeUnboundPage(targetId),
    log: () => {},
    warn: (message) => warnings.push(message),
  });
  const warnings: string[] = [];
  const operations = createOperations({
    engine,
    pages,
    profileFor: async () => "main",
    activity: reaper,
  });
  return { browser, kv, pages, operations, reaper, idle, warnings };
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

  // The point is not that A and B sit still while C opens a page — that is
  // true even with no tab select at all, because C's new page is where every
  // session's pointer was just dragged to. The point is that A and B can
  // still DRIVE their own pages afterwards.
  it("leaves the first two threads able to drive their own pages after a third joins", async () => {
    const { operations, kv } = await stack();
    await operations.open("thr_a", "https://a.example/");
    await operations.open("thr_b", "https://b.example/");
    const a = boundTarget(kv, "thr_a");
    const b = boundTarget(kv, "thr_b");

    await operations.open("thr_c", "https://c.example/");
    const c = boundTarget(kv, "thr_c");

    // Every session's pointer is now on C's page. Drive A and B anyway.
    await operations.open("thr_a", "https://a4.example/");
    await operations.open("thr_b", "https://b4.example/");

    expect(urlOf(a)).toBe("https://a4.example/");
    expect(urlOf(b)).toBe("https://b4.example/");
    expect(urlOf(c)).toBe("https://c.example/");
    expect(urlOf("decoy")).toBe("https://decoy.example/");
  });

  // Same proof with the connect landing on the OLDEST tab instead of the
  // newest, so a binding that happens to agree with "the newest tab" cannot
  // pass. Only agreeing with "the tab this thread is bound to" passes both.
  it("holds when a connect lands somewhere else entirely", async () => {
    const { operations, kv } = await stack(landOnOldest);
    await operations.open("thr_a", "https://a.example/");
    await operations.open("thr_b", "https://b.example/");
    const a = boundTarget(kv, "thr_a");
    const b = boundTarget(kv, "thr_b");

    await operations.open("thr_a", "https://a5.example/");

    expect(urlOf(a)).toBe("https://a5.example/");
    expect(urlOf(b)).toBe("https://b.example/");
    expect(urlOf("decoy")).toBe("https://decoy.example/");
  });

  // FINDING C of this task's report asks Task 10's reaper to call forget()
  // on a thread whose tab it closes. If it ever does that while the tab is
  // still open, the session is left holding the label with no binding to
  // account for it — and a duplicate label is refused outright.
  it("keeps working when the binding is forgotten under a live labelled tab", async () => {
    const { operations, pages, kv } = await stack();
    await operations.open("thr_a", "https://a.example/");
    await operations.open("thr_b", "https://b.example/");
    const b = boundTarget(kv, "thr_b");

    await pages.forget("thr_a");

    await expect(operations.open("thr_a", "https://a6.example/")).resolves.toBeTruthy();
    expect(urlOf(boundTarget(kv, "thr_a"))).toBe("https://a6.example/");
    expect(urlOf(b)).toBe("https://b.example/");
    expect(server.targets.filter((t) => t.url.startsWith("https://a"))).toHaveLength(1);
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

// The fake is where the measured behaviour of the real binary is written
// down, and every test above is only as honest as it is. Two properties in
// particular: without the first, "a session wedged out of binding" is
// invisible and the reconcile step in pages.ts looks like dead code; without
// the second, a tab closed over CDP would look like it wedges the session
// forever, which is not what the binary does.
describe("the fake agrees with the measured binary", () => {
  it("refuses a duplicate label within a session, and frees it when the tab closes", async () => {
    server = await fakeCdp();
    const browser = fakeBrowser(server);
    const run = (argv: string[]) =>
      browser.run({ profile: "main", session: "s", attach: true, argv });

    await run(["connect", server.url]);
    expect((await run(["tab", "new", "--label", "bbpage", "about:blank#bb-1"])).code).toBe(0);

    // Measured: "✗ Label `bbpage` is already used by another tab; labels must
    // be unique within a session" — exit 1, and no tab is created.
    const duplicate = await run(["tab", "new", "--label", "bbpage", "about:blank#bb-2"]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toMatch(/already used by another tab/);
    expect(server.targets).toHaveLength(1);

    // Measured: closing that tab over CDP — behind the session's back — frees
    // the label, and the same `tab new` then succeeds.
    server.targets = [];
    expect(browser.labelsOf("s")).toEqual([]);
    expect((await run(["tab", "new", "--label", "bbpage", "about:blank#bb-3"])).code).toBe(0);
  });
});

// The reaper over the real Pages and the real fake browser — the level at
// which "a page was reaped" means a tab actually left the browser, rather
// than a stub having been called.
describe("the reaper, end to end", () => {
  it("closes an idle thread's tab and its binding, and the thread just gets a new page", async () => {
    const { operations, pages, reaper, kv } = await stack();
    await operations.open("thr_a", "https://a.example/");
    const first = boundTarget(kv, "thr_a");
    expect(urlOf(first)).toBe("https://a.example/");

    // Far enough past the timeout that the touch `open` just recorded is
    // stale, and past the grace period the decoy is now serving.
    await reaper.sweep(Date.now() + 10_000);

    expect(server.targets.some((target) => target.targetId === first)).toBe(false);
    expect(kv.store.has("page:thr_a")).toBe(false);

    // ...and the thread is not wedged: it binds again, on a page of its own.
    await operations.open("thr_a", "https://a2.example/");
    expect(urlOf(boundTarget(kv, "thr_a"))).toBe("https://a2.example/");
  });

  it("never reaps a page while it is being watched, however idle it looks", async () => {
    const { operations, reaper, kv } = await stack();
    await operations.open("thr_a", "https://a.example/");
    const target = boundTarget(kv, "thr_a");

    reaper.watch("thr_a");
    await reaper.sweep(Date.now() + 10_000);
    expect(urlOf(target)).toBe("https://a.example/");

    reaper.unwatch("thr_a");
    await reaper.sweep(Date.now() + 20_000);
    expect(server.targets.some((candidate) => candidate.targetId === target)).toBe(false);
  });

  // The live defect this task exists for: a relaunched profile restores its
  // tabs, every one of them with a fresh target id no binding names. The
  // decoy stands in for exactly that.
  it("closes tabs nobody owns while leaving every bound page alone", async () => {
    const { operations, reaper, kv } = await stack();
    await operations.open("thr_a", "https://a.example/");
    await operations.open("thr_b", "https://b.example/");
    // Two more restored tabs, so this cannot pass by closing "the oldest" or
    // "the newest" alone.
    server.targets.push({ targetId: "restored-1", type: "page", url: "https://old1.example/" });
    server.targets.push({ targetId: "restored-2", type: "page", url: "https://old2.example/" });

    const now = Date.now();
    // Held by a viewer, so the idle pass cannot be what removes them and the
    // unbound pass is the only thing under test.
    reaper.watch("thr_a");
    reaper.watch("thr_b");
    await reaper.sweep(now);
    expect(server.targets).toHaveLength(5);

    await reaper.sweep(now + 600);
    expect(server.targets.map((target) => target.targetId).sort()).toEqual(
      [boundTarget(kv, "thr_a"), boundTarget(kv, "thr_b")].sort(),
    );
  });

  it("leaves a page alone that gains a binding during its grace period", async () => {
    const { operations, reaper, kv } = await stack();
    const now = Date.now();
    // First sight of the decoy AND of the page thr_a is about to be given —
    // except thr_a has not opened it yet, which is the point: this is the
    // window between `tab new` and the binding being written.
    await reaper.sweep(now);
    await operations.open("thr_a", "https://a.example/");
    reaper.watch("thr_a");

    await reaper.sweep(now + 600);
    expect(urlOf(boundTarget(kv, "thr_a"))).toBe("https://a.example/");
  });
});
