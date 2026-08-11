import { afterEach, describe, expect, it } from "vitest";
import {
  browserIdOf,
  closeTarget,
  httpOriginOf,
  listPageTargets,
  pageUrl,
  probeBrowserUrl,
} from "./browser-endpoint.js";
import { fakeCdp, type FakeCdp } from "./test-support/fake-cdp.js";

let server: FakeCdp;
afterEach(async () => {
  await server?.close();
});

describe("browser-endpoint", () => {
  it("lists only page targets", async () => {
    server = await fakeCdp();
    server.targets.push(
      { targetId: "p1", type: "page", url: "https://example.com/" },
      { targetId: "w1", type: "service_worker", url: "https://example.com/sw.js" },
    );
    expect(await listPageTargets(server.url)).toEqual([
      { targetId: "p1", type: "page", url: "https://example.com/" },
    ]);
  });

  // The reaper lists pages once a minute for the life of the plugin, and
  // every listing opens a CDP websocket. A leak here is invisible in any
  // functional assertion — the returned targets are correct either way —
  // and costs one socket per minute, forever, against a browser that has a
  // finite appetite for them. Confirmed non-discriminating before this
  // test existed: replacing `session.close()` with `void session` left the
  // whole suite green.
  it("leaves no CDP socket open behind a listing", async () => {
    server = await fakeCdp();
    await listPageTargets(server.url);
    await expect(server.whenConnections(0)).resolves.toBeUndefined();
  });

  it("leaves no CDP socket open behind a close", async () => {
    server = await fakeCdp();
    server.targets.push({ targetId: "p1", type: "page", url: "https://example.com/" });
    await closeTarget(server.url, "p1");
    expect(server.targets).toEqual([]);
    await expect(server.whenConnections(0)).resolves.toBeUndefined();
  });

  it("leaves no CDP socket open when the close itself fails", async () => {
    server = await fakeCdp();
    await expect(closeTarget(server.url, "gone")).rejects.toThrow(/No target/);
    await expect(server.whenConnections(0)).resolves.toBeUndefined();
  });

  it("probes a live browser over plain HTTP and reports its websocket", async () => {
    server = await fakeCdp();
    expect(await probeBrowserUrl(httpOriginOf(server.url))).toBe(server.url);
  });

  it("reports null for an origin nothing is answering on", async () => {
    server = await fakeCdp();
    const origin = httpOriginOf(server.url);
    await server.close();
    expect(await probeBrowserUrl(origin)).toBeNull();
  });

  it("derives a page websocket and a browser identity from a browser url", () => {
    expect(pageUrl("ws://127.0.0.1:9222/devtools/browser/abc", "t1")).toBe(
      "ws://127.0.0.1:9222/devtools/page/t1",
    );
    expect(browserIdOf("ws://127.0.0.1:9222/devtools/browser/abc")).toBe("abc");
    expect(browserIdOf("ws://127.0.0.1:9222/devtools/page/t1")).toBeNull();
  });
});
