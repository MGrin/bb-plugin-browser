// The four tests v1 did not have, against a real Brave.
//
// v1 shipped 335 unit tests and none of them crossed a boundary that mattered:
// not time, not a reconnect, not a second thread, not a human's tab. A defect
// that destroyed a page every thirty seconds passed all of them, and was found
// by a person trying to log into a website.
//
// These are slow, they start a real browser, and they are worth it. Each one
// corresponds to a failure that actually happened.
//
//   npm run test:live
//
// Skipped automatically when Brave is not installed, so the normal suite stays
// runnable anywhere.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BRAVE_BINARY, runningPort, startOrAttach } from "./brave.js";
import { createTabs, ownedKey, tabKey, type Tabs } from "./tabs.js";
import { memoryKv } from "./test-support/memory-kv.js";

const haveBrave = existsSync(BRAVE_BINARY);
const suite = haveBrave ? describe : describe.skip;

/** A sweep interval's worth of waiting, without waiting a real minute. */
const ACROSS_TIME_MS = 3_000;

suite("a real Brave, driven the way agents will drive it", () => {
  let profileDir = "";
  let endpoint = "";
  let browser: Browser | null = null;
  let kv = memoryKv();
  let tabs: Tabs;

  const connect = async () => {
    if (!browser || !browser.isConnected()) {
      browser = await chromium.connectOverCDP(endpoint);
    }
    return browser;
  };

  beforeAll(async () => {
    profileDir = await mkdtemp(join(tmpdir(), "bb-brave-live-"));
    const started = await startOrAttach({ profileDir, log: () => {} });
    endpoint = started.httpEndpoint;
    kv = memoryKv();
    tabs = createTabs({ browser: connect, kv, log: () => {} });
  }, 60_000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    // The browser is detached and outlives this process by design, so the
    // test has to end it explicitly — the plugin never would.
    const port = await runningPort(profileDir).catch(() => null);
    if (port) {
      await fetch(`http://127.0.0.1:${port}/json/version`)
        .then(async (response) => {
          const { webSocketDebuggerUrl } = (await response.json()) as {
            webSocketDebuggerUrl: string;
          };
          const socket = new WebSocket(webSocketDebuggerUrl);
          await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
          socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
          socket.close();
        })
        .catch(() => {});
    }
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  // 1. SURVIVES TIME.
  // The v1 failure: a page was destroyed and replaced roughly every thirty
  // seconds, so a login could never be completed. No unit test noticed,
  // because none of them let any time pass between two commands.
  it("keeps the same tab across a gap between commands", async () => {
    const first = await tabs.tabFor("thr_time");
    await first.page.goto("https://example.com/");

    await new Promise((resolve) => setTimeout(resolve, ACROSS_TIME_MS));

    const second = await tabs.tabFor("thr_time");
    expect(second.targetId).toBe(first.targetId);
    expect(second.page.url()).toBe("https://example.com/");
  }, 60_000);

  // 2. SURVIVES A RELOAD.
  // The v1 failure: reloading the plugin shut the browser down, which threw
  // away every tab and every thread's handle on one. Here the connection is
  // dropped and remade, exactly as a plugin reload does, and the thread must
  // find its own tab again rather than open a new one.
  it("finds the same tab again after the plugin reconnects", async () => {
    const before = await tabs.tabFor("thr_reload");
    await before.page.goto("https://example.org/");

    await browser?.close();
    browser = null;
    // A fresh Tabs over the SAME storage, like a plugin that just reloaded.
    const afterReload = createTabs({ browser: connect, kv, log: () => {} });

    const after = await afterReload.tabFor("thr_reload");
    expect(after.targetId).toBe(before.targetId);
    expect(after.page.url()).toBe("https://example.org/");
  }, 60_000);

  // 3. SURVIVES A PEER.
  // The v1 failure that hid for five tasks: every thread drove the same tab,
  // because `connect` silently ignored the page it was given. A two-thread
  // test would have caught it on day one — so here is the two-thread test.
  it("gives two threads two tabs that cannot move each other", async () => {
    const a = await tabs.tabFor("thr_a");
    const b = await tabs.tabFor("thr_b");
    expect(a.targetId).not.toBe(b.targetId);

    await Promise.all([
      a.page.goto("https://example.com/"),
      b.page.goto("https://example.org/"),
    ]);
    expect(new URL(a.page.url()).host).toBe("example.com");
    expect(new URL(b.page.url()).host).toBe("example.org");

    await b.page.goto("https://www.iana.org/help/example-domains");
    // A's page must not have moved because B navigated.
    expect(new URL(a.page.url()).host).toBe("example.com");
    expect(new URL(b.page.url()).host).toBe("www.iana.org");
  }, 60_000);

  // 4. NEVER CLOSES A HUMAN'S TAB.
  // The v1 failure: the reaper closed anything no binding named, which in a
  // headed window is precisely the tab a human opened to log in.
  it("can tell its own tabs from one a human opened", async () => {
    const mine = await tabs.tabFor("thr_owned");
    const humans = await (await connect()).contexts()[0]!.newPage();
    await humans.goto("https://example.com/?human");

    const listed = await tabs.listTabs();
    const ourEntry = listed.find((entry) => entry.targetId === mine.targetId);
    expect(ourEntry?.ours).toBe(true);
    expect(ourEntry?.sessionKey).toBe("thr_owned");

    const humanEntry = listed.find((entry) => entry.url.includes("?human"));
    expect(humanEntry).toBeDefined();
    expect(humanEntry?.ours).toBe(false);
    expect(humanEntry?.sessionKey).toBeNull();

    await humans.close();
  }, 60_000);

  it("forgets a tab it closed, and closing twice is not an error", async () => {
    const tab = await tabs.tabFor("thr_close");
    await tabs.closeTab("thr_close");
    expect(await kv.get(tabKey("thr_close"))).toBeUndefined();
    expect(await kv.get(ownedKey(tab.targetId))).toBeUndefined();
    await expect(tabs.closeTab("thr_close")).resolves.toBeUndefined();
  }, 60_000);
});
