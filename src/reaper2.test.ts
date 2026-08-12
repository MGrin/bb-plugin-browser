import { describe, expect, it } from "vitest";
import { createReaper2, idleMsFrom, type ReapableTab } from "./reaper2.js";

function reaperWith(tabs: ReapableTab[], idleMs = 1000) {
  const closed: string[] = [];
  const state = { tabs };
  const reaper = createReaper2({
    idleMs: async () => idleMs,
    listTabs: async () => state.tabs,
    closeTarget: async (targetId) => {
      closed.push(targetId);
      state.tabs = state.tabs.filter((tab) => tab.targetId !== targetId);
    },
    log: () => {},
    warn: () => {},
  });
  return { reaper, closed, state };
}

const ours = (targetId: string, sessionKey: string | null = null): ReapableTab => ({
  targetId,
  sessionKey,
  ours: true,
});

describe("reaper2", () => {
  // THE line. v1 closed a human's login tab out from under them in two
  // minutes, because it closed anything no binding named.
  it("never closes a tab this plugin did not open, however idle", async () => {
    const { reaper, closed } = reaperWith([
      { targetId: "humans", sessionKey: null, ours: false },
    ]);
    await reaper.sweep(0);
    await reaper.sweep(10_000_000);
    expect(closed).toEqual([]);
  });

  it("closes one of our tabs whose thread has not used it", async () => {
    const { reaper, closed } = reaperWith([ours("t1", "thr_a")]);
    reaper.touch("thr_a", 0);
    await reaper.sweep(5000);
    expect(closed).toEqual(["t1"]);
  });

  it("leaves a recently used tab alone", async () => {
    const { reaper, closed } = reaperWith([ours("t1", "thr_a")]);
    reaper.touch("thr_a", 4500);
    await reaper.sweep(5000);
    expect(closed).toEqual([]);
  });

  // A command that outlives the idle timeout must not have its tab closed
  // mid-flight — the hold, not the timestamp, is what guarantees that.
  it("never closes a tab while a command holds it", async () => {
    const { reaper, closed } = reaperWith([ours("t1", "thr_a")]);
    reaper.touch("thr_a", 0);
    reaper.watch("thr_a");
    await reaper.sweep(10_000_000);
    expect(closed).toEqual([]);
    reaper.unwatch("thr_a");
    await reaper.sweep(10_000_001);
    expect(closed).toEqual(["t1"]);
  });

  // A tab bound before this process started has no timestamp. Treating that
  // as "infinitely idle" would close a page a thread is actively using right
  // after any plugin reload.
  it("starts the clock on a tab it inherited rather than closing it", async () => {
    const { reaper, closed } = reaperWith([ours("t1", "thr_old")]);
    await reaper.sweep(10_000_000);
    expect(closed).toEqual([]);
    await reaper.sweep(10_000_500);
    expect(closed).toEqual([]);
    await reaper.sweep(10_002_000);
    expect(closed).toEqual(["t1"]);
  });

  // Our own tab that no thread claims: closed, but only after a grace period,
  // because a tab is created a moment before its binding is written.
  it("gives an orphan of ours a grace period, then closes it", async () => {
    const { reaper, closed } = reaperWith([ours("t1")]);
    await reaper.sweep(0);
    expect(closed).toEqual([]);
    await reaper.sweep(30_000);
    expect(closed).toEqual([]);
    await reaper.sweep(200_000);
    expect(closed).toEqual(["t1"]);
  });

  it("does not act at all when the browser cannot be listed", async () => {
    const closed: string[] = [];
    const reaper = createReaper2({
      idleMs: async () => 1,
      listTabs: async () => {
        throw new Error("no browser");
      },
      closeTarget: async (targetId) => closed.push(targetId) as unknown as void,
      log: () => {},
      warn: () => {},
    });
    await expect(reaper.sweep(10_000_000)).resolves.toBeUndefined();
    expect(closed).toEqual([]);
  });
});

describe("idleMsFrom", () => {
  it.each([
    ["30", 30 * 60_000],
    ["1", 60_000],
    ["", 30 * 60_000],
    ["nonsense", 30 * 60_000],
    ["0", 30 * 60_000],
    ["-5", 30 * 60_000],
  ])("%s -> %d ms", (raw, expected) => {
    expect(idleMsFrom(raw)).toBe(expected);
  });
});
