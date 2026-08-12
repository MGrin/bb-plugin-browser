import { afterEach, describe, expect, it, vi } from "vitest";
import { createScreencast } from "./screencast.js";
import { fakeCdp, type FakeCdp } from "./test-support/fake-cdp.js";

let server: FakeCdp;
afterEach(async () => { await server?.close(); });

function screencastFor() {
  return createScreencast({ quality: 60, maxWidth: 1280 });
}

/**
 * A frame's delivery is one event-loop hop: `server.emit` writes, the client
 * socket's message listener runs, the subscriber is called. A single macro
 * task is enough and is not a budget anything can overrun — unlike a socket
 * TEARDOWN, which is three hops across two processes' event loops and is
 * what `server.whenConnections(n)` is for. Nothing here waits on a teardown
 * by sleeping any more.
 */
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
    const screencast = screencastFor();
    await screencast.subscribe("thr_a", server.url, () => {});
    expect(server.received.some((m) => m.method === "Page.startScreencast")).toBe(true);
  });

  it("brings the page to the front, because a background tab renders nothing", async () => {
    // Measured against the real browser: with the thread's tab in the
    // background, `Page.startScreencast` returns 200 and then delivers zero
    // frames forever — Chrome does not composite a tab nobody is looking at.
    // The panel's whole job is that first frame, so a cast asks for the tab
    // to be shown before it asks for pixels.
    server = await fakeCdp();
    const screencast = screencastFor();
    await screencast.subscribe("thr_a", server.url, () => {});
    const methods = server.received.map((m) => m.method);
    expect(methods).toContain("Page.bringToFront");
    expect(methods.indexOf("Page.bringToFront")).toBeLessThan(
      methods.indexOf("Page.startScreencast"),
    );
  });

  it("still casts when the browser refuses to bring the page to the front", async () => {
    // Best-effort: a page that cannot be activated may still repaint (and a
    // stale last frame beats an error), so this must never fail a subscribe.
    server = await fakeCdp();
    server.failOn("Page.bringToFront", "not allowed");
    const screencast = screencastFor();
    await screencast.subscribe("thr_a", server.url, () => {});
    expect(server.received.some((m) => m.method === "Page.startScreencast")).toBe(true);
  });

  it("does not start a second cast for a second, sequential subscriber", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    await screencast.subscribe("thr_a", server.url, () => {});
    await screencast.subscribe("thr_a", server.url, () => {});
    expect(server.received.filter((m) => m.method === "Page.startScreencast")).toHaveLength(1);
  });

  it("coalesces concurrent subscribers racing for the same session into one cast", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    await Promise.all([
      screencast.subscribe("thr_a", server.url, () => {}),
      screencast.subscribe("thr_a", server.url, () => {}),
    ]);
    expect(server.received.filter((m) => m.method === "Page.startScreencast")).toHaveLength(1);
  });

  it("delivers frames to every subscriber and acks them", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    const seen: string[] = [];
    await screencast.subscribe("thr_a", server.url, (frame) => seen.push(frame));
    server.emit("Page.screencastFrame", { data: "FRAME", sessionId: 7 });
    await tick();
    expect(seen).toEqual(["FRAME"]);
    expect(server.received.some((m) => m.method === "Page.screencastFrameAck")).toBe(true);
  });

  // Chrome emits a frame when the screencast STARTS and then only on repaint,
  // so a viewer joining a running cast would otherwise sit blank until the
  // page happened to change — on a settled page, forever. Every "the panel
  // froze" report in live testing traced back to this: reconnecting after a
  // Reload joins the existing cast and waits for a repaint that never comes.
  it("paints a late subscriber immediately with the current frame", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    const early: string[] = [];
    await screencast.subscribe("thr_a", server.url, (frame) => early.push(frame));
    server.emit("Page.screencastFrame", { data: "BEFORE", sessionId: 1 });
    await tick();

    const late: string[] = [];
    await screencast.subscribe("thr_a", server.url, (frame) => late.push(frame));
    // Painted at once, without the page having repainted.
    expect(late).toEqual(["BEFORE"]);

    server.emit("Page.screencastFrame", { data: "AFTER", sessionId: 2 });
    await tick();
    expect(early).toEqual(["BEFORE", "AFTER"]);
    expect(late).toEqual(["BEFORE", "AFTER"]);
  });

  it("replays only the newest frame, not the history", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    await screencast.subscribe("thr_a", server.url, () => {});
    for (const data of ["ONE", "TWO", "THREE"]) {
      server.emit("Page.screencastFrame", { data, sessionId: 1 });
      await tick();
    }

    const late: string[] = [];
    await screencast.subscribe("thr_a", server.url, (frame) => late.push(frame));
    expect(late).toEqual(["THREE"]);
  });

  it("does not replay to the subscriber that started the cast", async () => {
    // Chrome sends that one its own start-of-screencast frame; replaying a
    // stale frame from a previous cast on the same key would show a picture
    // of the past.
    server = await fakeCdp();
    const screencast = screencastFor();
    const first: string[] = [];
    await screencast.subscribe("thr_a", server.url, (frame) => first.push(frame));
    expect(first).toEqual([]);
  });

  it("a subscriber that throws does not stop delivery to the others, or crash the process", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    const seenB: string[] = [];
    // A real onFrame throws exactly like this once its viewer's HTTP
    // response has aborted — e.g. a phone leaving the page mid-stream.
    await screencast.subscribe("thr_a", server.url, () => {
      throw new Error("boom");
    });
    await screencast.subscribe("thr_a", server.url, (frame) => seenB.push(frame));

    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.once("uncaughtException", onUncaught);
    try {
      server.emit("Page.screencastFrame", { data: "FRAME_1", sessionId: 1 });
      await tick();
      server.emit("Page.screencastFrame", { data: "FRAME_2", sessionId: 2 });
      await tick();
      expect(seenB).toEqual(["FRAME_1", "FRAME_2"]);
      expect(uncaught).toEqual([]);
    } finally {
      process.removeListener("uncaughtException", onUncaught);
    }
  });

  it("stops casting when the last subscriber leaves", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    const unsubscribe = await screencast.subscribe("thr_a", server.url, () => {});
    unsubscribe();
    // The socket really closing is the assertion, and a websocket teardown
    // is three hops across two event loops — so wait for the server to say
    // so, never for a fixed number of milliseconds.
    await server.whenConnections(0);
    expect(server.received.some((m) => m.method === "Page.stopScreencast")).toBe(true);
  });

  it("does not stop the cast while another subscriber is still watching", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    const unsubscribeA = await screencast.subscribe("thr_a", server.url, () => {});
    await screencast.subscribe("thr_a", server.url, () => {});
    unsubscribeA();
    await tick();
    expect(server.received.some((m) => m.method === "Page.stopScreencast")).toBe(false);
  });

  it("subscribing again after the cast fully stopped starts a fresh one", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    const unsubscribe = await screencast.subscribe("thr_a", server.url, () => {});
    unsubscribe();
    await server.whenConnections(0);
    await screencast.subscribe("thr_a", server.url, () => {});
    expect(server.received.filter((m) => m.method === "Page.startScreencast")).toHaveLength(2);
  });

  // The next two tests each isolate one of the two structural reasons a
  // stale unsubscribe cannot corrupt a fresh cast under the same session
  // key. Each fails if its specific mechanism is removed — a lookback
  // review found the original pair of tests here didn't actually exercise
  // either mechanism: deleting a non-member from a Set is always a no-op,
  // so a test that only checks "the fresh cast still delivers frames" never
  // touches the code paths below.

  it("a first-time unsubscribe from a stopAll'd cast does not remove a live subscription from a fresh cast reusing the same callback", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    const seen: string[] = [];
    const onFrame = (frame: string) => seen.push(frame);

    // Each unsubscribe closure captures its own cast object at subscribe
    // time rather than re-deriving "the current cast for this key" when
    // called — this test is what that buys: reusing the exact same
    // callback reference for a later, unrelated subscription must not let
    // a stale closure delete it out from under the fresh cast, the way a
    // naive `casts.get(sessionKey).subscribers.delete(onFrame)` would.
    const unsubscribeFromA = await screencast.subscribe("thr_a", server.url, onFrame);
    screencast.stopAll(); // tears A down directly; unsubscribeFromA has never been called
    await server.whenConnections(0);

    await screencast.subscribe("thr_a", server.url, onFrame); // B, same callback reference as A's

    // unsubscribeFromA's first and only call — a legitimate teardown of
    // the now-defunct first subscription, not a repeat.
    unsubscribeFromA();

    server.emit("Page.screencastFrame", { data: "FRAME", sessionId: 1 });
    await tick();
    expect(seen).toEqual(["FRAME"]);
  });

  it("a legitimate late unsubscribe from a stopAll'd cast does not corrupt the map entry of the cast that replaced it", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    const unsubscribeX = await screencast.subscribe("thr_a", server.url, () => {}); // A, subscriber 1
    const unsubscribeY = await screencast.subscribe("thr_a", server.url, () => {}); // A, subscriber 2
    unsubscribeX(); // A: 2 -> 1, no teardown yet
    screencast.stopAll(); // closes A directly; Y never got a chance to unsubscribe
    await server.whenConnections(0);

    await screencast.subscribe("thr_a", server.url, () => {}); // B, fresh cast under the same key
    expect(server.received.filter((m) => m.method === "Page.startScreencast")).toHaveLength(2); // A, B

    // Y's unsubscribe fires now for the first time (not a repeat): a
    // legitimate teardown of A's last, already-defunct subscriber. Without
    // stopCast's identity guard, this unconditionally deletes whatever is
    // *currently* at `casts.get(sessionKey)` — which by now is B, not A.
    unsubscribeY();
    await server.whenConnections(1); // B's, and only B's, still up

    // A third subscribe for the same key must still find B live rather
    // than start a redundant third cast — which is exactly what happens
    // if Y's teardown of A erased B's entry from the casts map.
    await screencast.subscribe("thr_a", server.url, () => {});
    expect(server.received.filter((m) => m.method === "Page.startScreencast")).toHaveLength(2);
  });

  it("stopAll closes every live cast, and a later subscribe starts fresh", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    await screencast.subscribe("thr_a", server.url, () => {});
    screencast.stopAll();
    await server.whenConnections(0);

    await screencast.subscribe("thr_a", server.url, () => {});
    expect(server.received.filter((m) => m.method === "Page.startScreencast")).toHaveLength(2);
  });

  it("stopAll racing an in-flight subscribe closes the session once it finishes starting, instead of leaving it running for nobody", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    // The handshake itself is the gate now, which is where a real start
    // actually waits — and `whenHeld` is how this test knows the client has
    // reached it, rather than assuming it from a sleep.
    server.holdConnections();
    const subscribing = screencast.subscribe("thr_a", server.url, () => {});
    await server.whenHeld(1);

    screencast.stopAll(); // races the connect, which has not completed yet
    server.releaseHeld(); // let the start finish, having already lost the race

    await expect(subscribing).rejects.toThrow();
    await server.whenConnections(0);
  });

  it("stopAll racing an in-flight subscribe does not let that stale start clobber a fresh cast created after stopAll", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();

    // A parks at the handshake; B is then let through freely, so B is fully
    // live before A ever finishes connecting.
    server.holdConnections();
    const staleSubscribe = screencast.subscribe("thr_a", server.url, () => {}); // A
    await server.whenHeld(1);
    screencast.stopAll(); // A is now stale before it ever connected
    server.allowConnections(); // future connects go through; A stays parked

    const freshSeen: string[] = [];
    const freshUnsubscribe = await screencast.subscribe(
      "thr_a",
      server.url,
      (frame) => freshSeen.push(frame),
    ); // B: connects immediately, since stopAll already ran

    server.releaseHeld(); // let A's connect proceed, now that B is already live
    await expect(staleSubscribe).rejects.toThrow();

    // Only B's socket should remain — A must have been closed on arrival,
    // never promoted over B in the casts map.
    await server.whenConnections(1);

    server.emit("Page.screencastFrame", { data: "FRAME", sessionId: 1 });
    await tick();
    expect(freshSeen).toEqual(["FRAME"]);

    // B is still reachable through the normal teardown path, proving the
    // map points at B — not at whatever A's late resolution tried to
    // install over it.
    freshUnsubscribe();
    await server.whenConnections(0);
    expect(server.received.some((m) => m.method === "Page.stopScreencast")).toBe(true);
  });

  it("a stale start's cleanup does not evict a fresh start's bookkeeping, so a third subscriber still coalesces instead of leaking an orphan", async () => {
    // Reproduces the exact interleaving a re-review found still leaked
    // after an epoch-only fix: A in flight, stopAll, B in flight, A
    // resolves and (in the buggy version) deletes B's `starting` entry,
    // so a third caller C no longer coalesces onto B and starts an
    // independent cast, which B's own late `casts.set` then clobbers —
    // leaving one of the two live sockets unreachable by `stopCast`
    // forever. A global "has stopAll run since I started" counter can't
    // prevent this: B and any C that starts independently share the same
    // post-stopAll generation, so a generation compare alone can't tell
    // "B, the entry still on record" apart from "a start that has since
    // replaced it". Only comparing this promise's own identity against
    // what `starting` currently holds works in every ordering — which is
    // why A's resolution (below) has to happen, and be fully processed,
    // *before* C's subscribe call, and B has to still be in flight (not
    // yet resolved) when C's coalescing decision is made.
    server = await fakeCdp();
    const screencast = screencastFor();

    // Both A and B park at the handshake, and they are released one at a
    // time — the queue is FIFO, so "release one" means A and only A.
    server.holdConnections();
    const subscribingA = screencast.subscribe("thr_a", server.url, () => {}); // A: parked
    await server.whenHeld(1);
    screencast.stopAll(); // A is now stale before it ever connected

    const seenB: string[] = [];
    const subscribingB = screencast.subscribe("thr_a", server.url, (frame) => seenB.push(frame)); // B: parked
    await server.whenHeld(2);

    // Let A finish connecting and discover it lost the race. Awaiting its
    // rejection guarantees A's cleanup has fully run — including whatever
    // it does to `starting` — before C ever calls subscribe, while B
    // (still parked) has not resolved yet either.
    server.releaseHeld(1);
    await expect(subscribingA).rejects.toThrow();

    // C arrives now, with B still in flight — it must coalesce onto B's
    // still-live `starting` entry rather than miss it because A's cleanup
    // (just above) wrongly evicted that entry.
    const seenC: string[] = [];
    const subscribingC = screencast.subscribe("thr_a", server.url, (frame) => seenC.push(frame));

    server.releaseHeld(1); // let B (and, if it coalesced, C) finish connecting
    const [unsubscribeB, unsubscribeC] = await Promise.all([subscribingB, subscribingC]);

    // Exactly two starts happened: A (superseded, closed on arrival) and
    // B (the one C coalesced onto). Three would mean C missed the
    // coalesce and started its own, independent cast.
    expect(server.received.filter((m) => m.method === "Page.startScreencast")).toHaveLength(2);

    server.emit("Page.screencastFrame", { data: "FRAME", sessionId: 1 });
    await tick();
    // Both B and C received it — proof they share the same cast, not two
    // separate ones.
    expect(seenB).toEqual(["FRAME"]);
    expect(seenC).toEqual(["FRAME"]);

    unsubscribeB();
    unsubscribeC();
    await server.whenConnections(0);

    // A later stopAll must find nothing left to clean up. The leak this
    // reproduces survives exactly because stopAll only walks `casts`, and
    // a wrongly-orphaned cast is no longer reachable there.
    screencast.stopAll();
    expect(server.connectionCount).toBe(0);
  });

  it("closes the CDP session if starting the cast fails partway through", async () => {
    server = await fakeCdp();
    server.failOn("Page.startScreencast", "boom");
    const screencast = screencastFor();
    await expect(screencast.subscribe("thr_a", server.url, () => {})).rejects.toThrow("boom");
    await server.whenConnections(0);
  });

  // The panel maps its own pixels into page pixels, so it needs the page's
  // coordinate space. Frame metadata carries it for free — every frame
  // reports the CSS viewport it was captured from — which beats a second CDP
  // round trip, and beats assuming the decoded frame size is the viewport
  // (`maxWidth` downscales, so on a wide or retina page they differ, and a
  // click would land proportionally off).

  it("reports the page viewport carried by the latest frame's metadata", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    await screencast.subscribe("thr_a", server.url, () => {});
    server.emit("Page.screencastFrame", {
      data: "FRAME",
      sessionId: 1,
      metadata: { deviceWidth: 1440, deviceHeight: 900 },
    });
    await tick();
    expect(screencast.viewportOf("thr_a")).toEqual({ width: 1440, height: 900 });
  });

  it("reports the viewport of the newest frame after a resize", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    await screencast.subscribe("thr_a", server.url, () => {});
    server.emit("Page.screencastFrame", {
      data: "A",
      sessionId: 1,
      metadata: { deviceWidth: 1440, deviceHeight: 900 },
    });
    await tick();
    server.emit("Page.screencastFrame", {
      data: "B",
      sessionId: 2,
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    });
    await tick();
    expect(screencast.viewportOf("thr_a")).toEqual({ width: 800, height: 600 });
  });

  it("reports no viewport for a session nothing is casting", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    expect(screencast.viewportOf("thr_a")).toBeNull();
  });

  it("reports no viewport before the first frame arrives", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    await screencast.subscribe("thr_a", server.url, () => {});
    expect(screencast.viewportOf("thr_a")).toBeNull();
  });

  it("ignores frame metadata with no usable dimensions", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    await screencast.subscribe("thr_a", server.url, () => {});
    // A zero-sized viewport would divide a click by zero downstream; a frame
    // missing metadata entirely is likewise not a viewport report.
    server.emit("Page.screencastFrame", {
      data: "A",
      sessionId: 1,
      metadata: { deviceWidth: 0, deviceHeight: 0 },
    });
    await tick();
    server.emit("Page.screencastFrame", { data: "B", sessionId: 2 });
    await tick();
    expect(screencast.viewportOf("thr_a")).toBeNull();
  });

  it("forgets a viewport once the cast stops", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    const unsubscribe = await screencast.subscribe("thr_a", server.url, () => {});
    server.emit("Page.screencastFrame", {
      data: "A",
      sessionId: 1,
      metadata: { deviceWidth: 1440, deviceHeight: 900 },
    });
    await tick();
    unsubscribe();
    await tick();
    // A stale viewport would outlive the page it described, and the panel
    // reads "nothing is casting" from exactly this null.
    expect(screencast.viewportOf("thr_a")).toBeNull();
  });

  it("dispatches a mouse click as a CDP input event", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    await screencast.subscribe("thr_a", server.url, () => {});
    await screencast.dispatchInput("thr_a", CLICK);
    const sent = server.received.find((m) => m.method === "Input.dispatchMouseEvent");
    expect(sent?.params).toMatchObject({ type: "mousePressed", x: 10, y: 20, button: "left" });
  });

  it("dispatches a scroll as a CDP mouse wheel event", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    await screencast.subscribe("thr_a", server.url, () => {});
    await screencast.dispatchInput("thr_a", { kind: "scroll", x: 5, y: 6, deltaY: 100 });
    const sent = server.received.find((m) => m.method === "Input.dispatchMouseEvent");
    expect(sent?.params).toMatchObject({ type: "mouseWheel", x: 5, y: 6, deltaY: 100 });
  });

  it("dispatches a key event as CDP Input.dispatchKeyEvent", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    await screencast.subscribe("thr_a", server.url, () => {});
    await screencast.dispatchInput("thr_a", { kind: "key", type: "keyDown", key: "Enter" });
    const sent = server.received.find((m) => m.method === "Input.dispatchKeyEvent");
    expect(sent?.params).toMatchObject({ type: "keyDown", key: "Enter" });
  });

  // Input has no page url of its own, and it must not be able to obtain
  // one: the old fallback resolved a page through the launch-capable path,
  // so a click aimed at a page that had just closed could mint a blank tab
  // — or start a browser — from a keystroke. Nothing is casting now means
  // the event is refused, and the panel is what turns that into a quiet
  // "not delivered" (it gates on `viewportOf` first).
  it("refuses input for a session nothing is casting, and opens no connection to find out", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    await expect(screencast.dispatchInput("thr_a", CLICK)).rejects.toThrow(/nothing is casting/);
    expect(server.connectionCount).toBe(0);
    expect(server.received).toEqual([]);
  });

  it("surfaces a failed input send instead of swallowing it", async () => {
    server = await fakeCdp();
    server.failOn("Input.dispatchMouseEvent", "boom");
    const screencast = screencastFor();
    await screencast.subscribe("thr_a", server.url, () => {});
    await expect(screencast.dispatchInput("thr_a", CLICK)).rejects.toThrow("boom");
    // The cast's own session survives a failed send: it belongs to
    // subscribe/stopCast, and one bad click must not blank the view.
    expect(server.connectionCount).toBe(1);
  });

  it("reuses the live cast's session for dispatchInput instead of opening a second connection", async () => {
    server = await fakeCdp();
    const screencast = screencastFor();
    await screencast.subscribe("thr_a", server.url, () => {});
    expect(server.connectionCount).toBe(1);
    await screencast.dispatchInput("thr_a", CLICK);
    await tick();
    // Still just the cast's own session — dispatchInput must not have
    // opened, and then had to close, a second one.
    expect(server.connectionCount).toBe(1);
  });
});

// A headless tab that loses the foreground stops producing frames entirely,
// so the panel freezes while the page underneath goes on working: you type,
// the keystroke lands, and nothing changes on screen. Asking once at cast
// start is not enough — anything else opening a tab in the shared browser can
// take the foreground away afterwards.
describe("holding the foreground while someone is watching", () => {
  it("keeps asking for the foreground, not just once at the start", async () => {
    vi.useFakeTimers();
    try {
      server = await fakeCdp();
      const screencast = screencastFor();
      await screencast.subscribe("thr_a", server.url, () => {});
      const before = server.received.filter((m) => m.method === "Page.bringToFront").length;
      expect(before).toBe(1);

      await vi.advanceTimersByTimeAsync(3500);
      const after = server.received.filter((m) => m.method === "Page.bringToFront").length;
      expect(after).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops asking once the last viewer leaves", async () => {
    vi.useFakeTimers();
    try {
      server = await fakeCdp();
      const screencast = screencastFor();
      const unsubscribe = await screencast.subscribe("thr_a", server.url, () => {});
      await vi.advanceTimersByTimeAsync(2500);
      unsubscribe();
      const settled = server.received.filter((m) => m.method === "Page.bringToFront").length;

      await vi.advanceTimersByTimeAsync(5000);
      expect(
        server.received.filter((m) => m.method === "Page.bringToFront").length,
      ).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });
});
