import { afterEach, describe, expect, it } from "vitest";
import { createScreencast } from "./screencast.js";
import { fakeCdp, type FakeCdp } from "./test-support/fake-cdp.js";

let server: FakeCdp;
afterEach(async () => { await server?.close(); });

function screencastFor(url: string) {
  return createScreencast({
    pages: {
      pageUrlFor: async () => url,
      existingPageUrl: async () => null,
      closePage: async () => {},
      forget: async () => {},
    },
    quality: 60,
    maxWidth: 1280,
  });
}

async function tick(ms = 20) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise plus its own resolver, for pinning down exact race orderings. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
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

  it("a subscriber that throws does not stop delivery to the others, or crash the process", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    const seenB: string[] = [];
    // A real onFrame throws exactly like this once its viewer's HTTP
    // response has aborted — e.g. a phone leaving the page mid-stream.
    await screencast.subscribe("thr_a", "main", () => {
      throw new Error("boom");
    });
    await screencast.subscribe("thr_a", "main", (frame) => seenB.push(frame));

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

  it("subscribing again after the cast fully stopped starts a fresh one", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    const unsubscribe = await screencast.subscribe("thr_a", "main", () => {});
    unsubscribe();
    await tick();
    await screencast.subscribe("thr_a", "main", () => {});
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
    const screencast = screencastFor(server.url);
    const seen: string[] = [];
    const onFrame = (frame: string) => seen.push(frame);

    // Each unsubscribe closure captures its own cast object at subscribe
    // time rather than re-deriving "the current cast for this key" when
    // called — this test is what that buys: reusing the exact same
    // callback reference for a later, unrelated subscription must not let
    // a stale closure delete it out from under the fresh cast, the way a
    // naive `casts.get(sessionKey).subscribers.delete(onFrame)` would.
    const unsubscribeFromA = await screencast.subscribe("thr_a", "main", onFrame);
    screencast.stopAll(); // tears A down directly; unsubscribeFromA has never been called
    await tick();

    await screencast.subscribe("thr_a", "main", onFrame); // B, same callback reference as A's

    // unsubscribeFromA's first and only call — a legitimate teardown of
    // the now-defunct first subscription, not a repeat.
    unsubscribeFromA();

    server.emit("Page.screencastFrame", { data: "FRAME", sessionId: 1 });
    await tick();
    expect(seen).toEqual(["FRAME"]);
  });

  it("a legitimate late unsubscribe from a stopAll'd cast does not corrupt the map entry of the cast that replaced it", async () => {
    server = await fakeCdp();
    const screencast = screencastFor(server.url);
    const unsubscribeX = await screencast.subscribe("thr_a", "main", () => {}); // A, subscriber 1
    const unsubscribeY = await screencast.subscribe("thr_a", "main", () => {}); // A, subscriber 2
    unsubscribeX(); // A: 2 -> 1, no teardown yet
    screencast.stopAll(); // closes A directly; Y never got a chance to unsubscribe
    await tick();

    await screencast.subscribe("thr_a", "main", () => {}); // B, fresh cast under the same key
    expect(server.received.filter((m) => m.method === "Page.startScreencast")).toHaveLength(2); // A, B

    // Y's unsubscribe fires now for the first time (not a repeat): a
    // legitimate teardown of A's last, already-defunct subscriber. Without
    // stopCast's identity guard, this unconditionally deletes whatever is
    // *currently* at `casts.get(sessionKey)` — which by now is B, not A.
    unsubscribeY();
    await tick();

    // A third subscribe for the same key must still find B live rather
    // than start a redundant third cast — which is exactly what happens
    // if Y's teardown of A erased B's entry from the casts map.
    await screencast.subscribe("thr_a", "main", () => {});
    expect(server.received.filter((m) => m.method === "Page.startScreencast")).toHaveLength(2);
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

  it("stopAll racing an in-flight subscribe closes the session once it finishes starting, instead of leaving it running for nobody", async () => {
    server = await fakeCdp();
    const gate = deferred<string>();
    const screencast = createScreencast({
      pages: {
        pageUrlFor: async () => gate.promise,
        existingPageUrl: async () => null,
        closePage: async () => {},
        forget: async () => {},
      },
      quality: 60,
      maxWidth: 1280,
    });

    const subscribing = screencast.subscribe("thr_a", "main", () => {});
    screencast.stopAll(); // races the connect, which hasn't resolved pageUrlFor yet
    gate.resolve(server.url); // let the start proceed, now that it has already lost the race

    await expect(subscribing).rejects.toThrow();
    await tick();
    expect(server.connectionCount).toBe(0);
  });

  it("stopAll racing an in-flight subscribe does not let that stale start clobber a fresh cast created after stopAll", async () => {
    server = await fakeCdp();
    const gate = deferred<string>();
    let pageUrlForCalls = 0;
    const screencast = createScreencast({
      pages: {
        // The first call (A, pre-stopAll) sticks on the gate; every call
        // after that (B, post-stopAll) resolves immediately.
        pageUrlFor: async () => {
          pageUrlForCalls += 1;
          return pageUrlForCalls === 1 ? gate.promise : server.url;
        },
        existingPageUrl: async () => null,
        closePage: async () => {},
        forget: async () => {},
      },
      quality: 60,
      maxWidth: 1280,
    });

    const staleSubscribe = screencast.subscribe("thr_a", "main", () => {}); // A: stuck on the gate
    screencast.stopAll(); // A is now stale before it ever connected

    const freshSeen: string[] = [];
    const freshUnsubscribe = await screencast.subscribe(
      "thr_a",
      "main",
      (frame) => freshSeen.push(frame),
    ); // B: connects immediately, since stopAll already ran

    gate.resolve(server.url); // let A's connect proceed, now that B is already live
    await expect(staleSubscribe).rejects.toThrow();
    await tick();

    // Only B's socket should remain — A must have been closed on arrival,
    // never promoted over B in the casts map.
    expect(server.connectionCount).toBe(1);

    server.emit("Page.screencastFrame", { data: "FRAME", sessionId: 1 });
    await tick();
    expect(freshSeen).toEqual(["FRAME"]);

    // B is still reachable through the normal teardown path, proving the
    // map points at B — not at whatever A's late resolution tried to
    // install over it.
    freshUnsubscribe();
    await tick();
    expect(server.received.some((m) => m.method === "Page.stopScreencast")).toBe(true);
    expect(server.connectionCount).toBe(0);
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
    const gateA = deferred<string>();
    const gateB = deferred<string>();
    let pageUrlForCalls = 0;
    const screencast = createScreencast({
      pages: {
        // 1st call is A's, stuck until gateA resolves. 2nd is B's, stuck
        // until gateB resolves. 3rd (C's, if it starts independently) and
        // anything after resolves immediately.
        pageUrlFor: async () => {
          pageUrlForCalls += 1;
          if (pageUrlForCalls === 1) return gateA.promise;
          if (pageUrlForCalls === 2) return gateB.promise;
          return server.url;
        },
        existingPageUrl: async () => null,
        closePage: async () => {},
        forget: async () => {},
      },
      quality: 60,
      maxWidth: 1280,
    });

    const subscribingA = screencast.subscribe("thr_a", "main", () => {}); // A: stuck on gateA
    screencast.stopAll(); // A is now stale before it ever connected

    const seenB: string[] = [];
    const subscribingB = screencast.subscribe("thr_a", "main", (frame) => seenB.push(frame)); // B: stuck on gateB

    // Let A finish connecting and discover it lost the race. Awaiting its
    // rejection guarantees A's cleanup has fully run — including whatever
    // it does to `starting` — before C ever calls subscribe, while B
    // (still on gateB) has not resolved yet either.
    gateA.resolve(server.url);
    await expect(subscribingA).rejects.toThrow();

    // C arrives now, with B still in flight — it must coalesce onto B's
    // still-live `starting` entry rather than miss it because A's cleanup
    // (just above) wrongly evicted that entry.
    const seenC: string[] = [];
    const subscribingC = screencast.subscribe("thr_a", "main", (frame) => seenC.push(frame));

    gateB.resolve(server.url); // let B (and, if it coalesced, C) finish connecting
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
    await tick();
    expect(server.connectionCount).toBe(0);

    // A later stopAll must find nothing left to clean up. The leak this
    // reproduces survives exactly because stopAll only walks `casts`, and
    // a wrongly-orphaned cast is no longer reachable there.
    screencast.stopAll();
    expect(server.connectionCount).toBe(0);
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
