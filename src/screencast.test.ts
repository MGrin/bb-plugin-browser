import { afterEach, describe, expect, it } from "vitest";
import { createScreencast } from "./screencast.js";
import { fakeCdp, type FakeCdp } from "./test-support/fake-cdp.js";

let server: FakeCdp;
afterEach(async () => { await server?.close(); });

function screencastFor(url: string) {
  return createScreencast({
    pages: { pageUrlFor: async () => url, closePage: async () => {}, forget: async () => {} },
    quality: 60,
    maxWidth: 1280,
  });
}

async function tick(ms = 20) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const CLICK = {
  kind: "mouse" as const,
  type: "mousePressed" as const,
  x: 10,
  y: 20,
  button: "left" as const,
  clickCount: 1,
};

describe("screencast", () => {
  it("starts casting on the first subscriber", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    await screencast.subscribe("thr_a", "main", () => {});
    expect(server.received.some((m) => m.method === "Page.startScreencast")).toBe(true);
  });

  it("does not start a second cast for a second, sequential subscriber", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    await screencast.subscribe("thr_a", "main", () => {});
    await screencast.subscribe("thr_a", "main", () => {});
    expect(server.received.filter((m) => m.method === "Page.startScreencast")).toHaveLength(1);
  });

  it("coalesces concurrent subscribers racing for the same session into one cast", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    await Promise.all([
      screencast.subscribe("thr_a", "main", () => {}),
      screencast.subscribe("thr_a", "main", () => {}),
    ]);
    expect(server.received.filter((m) => m.method === "Page.startScreencast")).toHaveLength(1);
  });

  it("delivers frames to every subscriber and acks them", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    const seen: string[] = [];
    await screencast.subscribe("thr_a", "main", (frame) => seen.push(frame));
    server.emit("Page.screencastFrame", { data: "FRAME", sessionId: 7 });
    await tick();
    expect(seen).toEqual(["FRAME"]);
    expect(server.received.some((m) => m.method === "Page.screencastFrameAck")).toBe(true);
  });

  it("a subscriber that joins mid-cast never receives frames sent before it joined", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    const early: string[] = [];
    await screencast.subscribe("thr_a", "main", (frame) => early.push(frame));
    server.emit("Page.screencastFrame", { data: "BEFORE", sessionId: 1 });
    await tick();

    const late: string[] = [];
    await screencast.subscribe("thr_a", "main", (frame) => late.push(frame));
    server.emit("Page.screencastFrame", { data: "AFTER", sessionId: 2 });
    await tick();

    expect(early).toEqual(["BEFORE", "AFTER"]);
    expect(late).toEqual(["AFTER"]);
  });

  it("stops casting when the last subscriber leaves", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    const unsubscribe = await screencast.subscribe("thr_a", "main", () => {});
    unsubscribe();
    await tick();
    expect(server.received.some((m) => m.method === "Page.stopScreencast")).toBe(true);
    expect(server.connectionCount).toBe(0);
  });

  it("does not stop the cast while another subscriber is still watching", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    const unsubscribeA = await screencast.subscribe("thr_a", "main", () => {});
    await screencast.subscribe("thr_a", "main", () => {});
    unsubscribeA();
    await tick();
    expect(server.received.some((m) => m.method === "Page.stopScreencast")).toBe(false);
  });

  it("a repeated unsubscribe call is a harmless no-op", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    const unsubscribe = await screencast.subscribe("thr_a", "main", () => {});
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    await tick();
    expect(server.received.filter((m) => m.method === "Page.stopScreencast")).toHaveLength(1);
  });

  it("subscribing again after the cast fully stopped starts a fresh one", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    const unsubscribe = await screencast.subscribe("thr_a", "main", () => {});
    unsubscribe();
    await tick();
    await screencast.subscribe("thr_a", "main", () => {});
    expect(server.received.filter((m) => m.method === "Page.startScreencast")).toHaveLength(2);
  });

  it("a stale unsubscribe left over from a stopAll does not tear down the cast that replaced it", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    const unsubscribeX = await screencast.subscribe("thr_a", "main", () => {});
    const unsubscribeY = await screencast.subscribe("thr_a", "main", () => {});
    screencast.stopAll();
    await tick();

    const seen: string[] = [];
    await screencast.subscribe("thr_a", "main", (frame) => seen.push(frame));
    // Leftover unsubscribes from the cast stopAll already tore down must not
    // touch the fresh cast that now lives under the same session key.
    unsubscribeX();
    unsubscribeY();
    server.emit("Page.screencastFrame", { data: "FRAME", sessionId: 1 });
    await tick();

    expect(seen).toEqual(["FRAME"]);
  });

  it("stopAll closes every live cast, and a later subscribe starts fresh", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    await screencast.subscribe("thr_a", "main", () => {});
    screencast.stopAll();
    await tick();
    expect(server.connectionCount).toBe(0);

    await screencast.subscribe("thr_a", "main", () => {});
    expect(server.received.filter((m) => m.method === "Page.startScreencast")).toHaveLength(2);
  });

  it("closes the CDP session if starting the cast fails partway through", async () => {
    server = await fakeCdp();
    server.failOn("Page.startScreencast", "boom");
    const screencast = screencastFor(server.url);
    await expect(screencast.subscribe("thr_a", "main", () => {})).rejects.toThrow("boom");
    await tick();
    expect(server.connectionCount).toBe(0);
  });

  it("dispatches a mouse click as a CDP input event", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    await screencast.dispatchInput("thr_a", "main", CLICK);
    const sent = server.received.find((m) => m.method === "Input.dispatchMouseEvent");
    expect(sent?.params).toMatchObject({ type: "mousePressed", x: 10, y: 20, button: "left" });
  });

  it("dispatches a scroll as a CDP mouse wheel event", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    await screencast.dispatchInput("thr_a", "main", { kind: "scroll", x: 5, y: 6, deltaY: 100 });
    const sent = server.received.find((m) => m.method === "Input.dispatchMouseEvent");
    expect(sent?.params).toMatchObject({ type: "mouseWheel", x: 5, y: 6, deltaY: 100 });
  });

  it("dispatches a key event as CDP Input.dispatchKeyEvent", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    await screencast.dispatchInput("thr_a", "main", { kind: "key", type: "keyDown", key: "Enter" });
    const sent = server.received.find((m) => m.method === "Input.dispatchKeyEvent");
    expect(sent?.params).toMatchObject({ type: "keyDown", key: "Enter" });
  });

  it("opens and closes a throwaway session for dispatchInput when nobody is subscribed", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    await screencast.dispatchInput("thr_a", "main", CLICK);
    await tick();
    expect(server.connectionCount).toBe(0);
  });

  it("closes the throwaway dispatchInput session even when the send itself rejects", async () => {
    server = await fakeCdp();
    server.failOn("Input.dispatchMouseEvent", "boom");
    const screencast = screencastFor(server.url);
    await expect(screencast.dispatchInput("thr_a", "main", CLICK)).rejects.toThrow("boom");
    await tick();
    expect(server.connectionCount).toBe(0);
  });

  it("reuses the live cast's session for dispatchInput instead of opening a second connection", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    await screencast.subscribe("thr_a", "main", () => {});
    expect(server.connectionCount).toBe(1);
    await screencast.dispatchInput("thr_a", "main", CLICK);
    await tick();
    // Still just the cast's own session — dispatchInput must not have
    // opened, and then had to close, a second one.
    expect(server.connectionCount).toBe(1);
  });
});
