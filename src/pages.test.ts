import { afterEach, describe, expect, it } from "vitest";
import { createPages } from "./pages.js";
import { fakeCdp, type FakeCdp } from "./test-support/fake-cdp.js";

let server: FakeCdp;
afterEach(async () => { await server?.close(); });

function memoryKv() {
  const store = new Map<string, unknown>();
  return {
    get: async <T,>(key: string) => store.get(key) as T | undefined,
    set: async (key: string, value: unknown) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
  };
}

function pagesFor(url: string) {
  const engine = {
    browserCdpUrl: async () => url,
    run: async () => ({ stdout: "", stderr: "", code: 0 }),
    shutdown: async () => {},
    shutdownAll: async () => {},
  };
  return createPages({ engine, kv: memoryKv(), log: () => {} });
}

describe("pages", () => {
  it("creates a page and returns its own websocket", async () => {
    server = await fakeCdp();
    const pages = pagesFor(server.url);
    const pageUrl = await pages.pageUrlFor("thr_a", "main");
    expect(pageUrl).toMatch(/\/devtools\/page\/page-1$/);
    expect(server.received.some((m) => m.method === "Target.createTarget")).toBe(true);
  });

  it("reuses the same page for the same session", async () => {
    server = await fakeCdp();
    const pages = pagesFor(server.url);
    const first = await pages.pageUrlFor("thr_a", "main");
    const second = await pages.pageUrlFor("thr_a", "main");
    expect(second).toBe(first);
    expect(server.received.filter((m) => m.method === "Target.createTarget")).toHaveLength(1);
  });

  it("gives two sessions two different pages", async () => {
    server = await fakeCdp();
    const pages = pagesFor(server.url);
    const a = await pages.pageUrlFor("thr_a", "main");
    const b = await pages.pageUrlFor("thr_b", "main");
    expect(a).not.toBe(b);
  });

  it("recreates a page the user closed behind our back", async () => {
    server = await fakeCdp();
    const pages = pagesFor(server.url);
    await pages.pageUrlFor("thr_a", "main");
    server.targets = [];
    const revived = await pages.pageUrlFor("thr_a", "main");
    expect(revived).toMatch(/\/devtools\/page\/page-2$/);
  });

  it("closes a page through CDP, because detaching leaves it alive", async () => {
    server = await fakeCdp();
    const pages = pagesFor(server.url);
    await pages.pageUrlFor("thr_a", "main");
    await pages.closePage("thr_a");
    expect(server.received.some((m) => m.method === "Target.closeTarget")).toBe(true);
    expect(server.targets).toHaveLength(0);
  });
});
