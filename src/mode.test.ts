import { describe, expect, it, vi } from "vitest";
import {
  autoHideMsFrom,
  createModeSwitch,
  DEFAULT_HEADED_HOURS,
  humanizeDuration,
  type ModeDeps,
} from "./mode.js";

const HOUR = 3_600_000;

function switchWith(overrides: Partial<ModeDeps> = {}) {
  const calls: string[] = [];
  const state = { mode: "headless" as "headless" | "headed" };
  const deps: ModeDeps = {
    currentMode: async () => state.mode,
    running: async () => true,
    modeSince: async () => 0,
    autoHideAfterMs: async () => DEFAULT_HEADED_HOURS * HOUR,
    busy: () => false,
    capture: async () => [
      { sessionKey: "thr_a", url: "https://example.com/" },
      { sessionKey: "thr_blank", url: "about:blank" },
    ],
    quit: async () => {
      calls.push("quit");
      return true;
    },
    relaunch: async (mode) => {
      calls.push(`relaunch ${mode}`);
      state.mode = mode;
    },
    restore: async (sessionKey, url) => {
      calls.push(`restore ${sessionKey} ${url}`);
    },
    log: () => {},
    ...overrides,
  };
  return { mode: createModeSwitch(deps), calls, state };
}

/** Headed, launched at t=0, so `now` reads straight as "headed for this long". */
function headedFor(ms: number, overrides: Partial<ModeDeps> = {}) {
  const built = switchWith({ currentMode: async () => "headed", modeSince: async () => 0, ...overrides });
  built.state.mode = "headed";
  return { ...built, now: ms };
}

describe("mode switching", () => {
  it("relaunches headed and puts each thread back where it was", async () => {
    const { mode, calls } = switchWith();
    const message = await mode.show();
    expect(calls).toEqual([
      "quit",
      "relaunch headed",
      "restore thr_a https://example.com/",
    ]);
    expect(message).toContain("on screen");
  });

  // A blank tab restored is still a blank tab; reopening it only costs time.
  it("does not restore pages that were never anywhere", async () => {
    const { calls } = switchWith();
    expect(calls.filter((call) => call.includes("about:blank"))).toEqual([]);
  });

  // Asking for the mode it is already in must not tear the browser down —
  // that would throw away every tab for no reason at all.
  it("does nothing when already in the requested mode", async () => {
    const { mode, calls } = switchWith();
    const message = await mode.hide();
    expect(calls).toEqual([]);
    expect(message).toContain("already headless");
  });

  it("captures before quitting, not after", async () => {
    const order: string[] = [];
    const { mode } = switchWith({
      capture: async () => {
        order.push("capture");
        return [{ sessionKey: "thr_a", url: "https://example.com/" }];
      },
      quit: async () => {
        order.push("quit");
        return true;
      },
    });
    await mode.show();
    expect(order).toEqual(["capture", "quit"]);
  });

  it("restores the rest when one page fails to come back", async () => {
    const restored: string[] = [];
    const { mode } = switchWith({
      capture: async () => [
        { sessionKey: "thr_a", url: "https://a.example/" },
        { sessionKey: "thr_b", url: "https://b.example/" },
      ],
      restore: async (sessionKey) => {
        if (sessionKey === "thr_a") throw new Error("gone");
        restored.push(sessionKey);
      },
    });
    const message = await mode.show();
    expect(restored).toEqual(["thr_b"]);
    expect(message).toContain("1 of 2");
  });

  it("says plainly that unsubmitted input is lost", async () => {
    const { mode } = switchWith();
    expect(await mode.show()).toContain("not submitted is gone");
  });
});

// The measurement this whole feature rests on (MX-297), taken 2026-08-22 over
// 759 lines of ~/.bb/plugins/browser/logs/plugin.log covering 2026-08-11T07:36Z
// onward. Headed episodes are BIMODAL and nothing lands in between:
//
//   69.35h  nobody hid it (ended by a browser restart)
//      70s  deliberate `hide`
//     193s  deliberate `hide`
//     125s  deliberate `hide`
//   89.68h  still headed when this was written
//
// Every real human takeover was ended by somebody calling `hide`, within 193s.
// Both drifts ran 69-90h with no `hide` at all. The gap is 1291x with nothing
// in it, and 159.04h of 159.15h headed exposure (99.9%) is the two nobody hid.
//
// So the threshold is not taste: it goes in a three-order-of-magnitude empty
// band. These two tests pin both edges of that band, and they are the
// falsifier — if a real takeover ever runs past the threshold, the first fails.
describe("the measured band the threshold sits in", () => {
  it("does not fire on a takeover the length of the longest one measured", async () => {
    const { mode, now } = headedFor(193_000);
    expect(await mode.autoHide(now)).toBeNull();
  });

  it("fires on a drift the length of the shortest one measured", async () => {
    const { mode, now, state } = headedFor(69.35 * HOUR);
    expect(await mode.autoHide(now)).not.toBeNull();
    expect(state.mode).toBe("headless");
  });
});

describe("returning to headless on its own", () => {
  it("does nothing when the browser is already headless", async () => {
    const { mode, calls } = switchWith();
    expect(await mode.autoHide(999 * HOUR)).toBeNull();
    expect(calls.filter((call) => call.startsWith("quit"))).toEqual([]);
  });

  it("does nothing before the threshold", async () => {
    const { mode, state } = headedFor(DEFAULT_HEADED_HOURS * HOUR - 1);
    expect(await mode.autoHide(DEFAULT_HEADED_HOURS * HOUR - 1)).toBeNull();
    expect(state.mode).toBe("headed");
  });

  it("puts the browser back once the threshold is passed", async () => {
    const { mode, calls, state } = headedFor(DEFAULT_HEADED_HOURS * HOUR);
    const message = await mode.autoHide(DEFAULT_HEADED_HOURS * HOUR);
    expect(state.mode).toBe("headless");
    expect(calls).toContain("quit");
    expect(calls).toContain("relaunch headless");
    // Restoring is inherited from the manual switch: a thread's page comes back.
    expect(calls).toContain("restore thr_a https://example.com/");
    expect(message).toBeTruthy();
  });

  // A human who meets a vanished window with no explanation has been given a
  // bug; one who is told what happened and how to undo it has been given a
  // recoverable inconvenience. That difference is the whole price of a wrong
  // hide, so it is asserted rather than left to the implementation.
  it("says how long it had been on screen, and how to bring it back", async () => {
    const { mode } = headedFor(70 * HOUR);
    const message = (await mode.autoHide(70 * HOUR)) ?? "";
    expect(message).toContain("2d 22h");
    expect(message).toContain("bb browser show");
  });

  it("can be turned off entirely, however long it has been headed", async () => {
    const { mode, state } = headedFor(999 * HOUR, { autoHideAfterMs: async () => 0 });
    expect(await mode.autoHide(999 * HOUR)).toBeNull();
    expect(state.mode).toBe("headed");
  });

  // An unknown clock must not be read as "just now" (which would never fire)
  // OR as "forever ago" (which would fire immediately, on a browser somebody
  // may be looking at right now). It is a third answer: don't act.
  it("does nothing when it cannot tell how long it has been headed", async () => {
    const { mode, state } = headedFor(999 * HOUR, { modeSince: async () => null });
    expect(await mode.autoHide(999 * HOUR)).toBeNull();
    expect(state.mode).toBe("headed");
  });

  // Switching modes is a relaunch, so doing it under a live page command turns
  // somebody else's `open` into an error. The clock has waited hours; it can
  // wait for the next sweep.
  it("waits while an agent has a page command in flight", async () => {
    const { mode, state } = headedFor(999 * HOUR, { busy: () => true });
    expect(await mode.autoHide(999 * HOUR)).toBeNull();
    expect(state.mode).toBe("headed");
  });

  // A browser that crashed while headed leaves the mode file saying "headed".
  // Acting on that would START a browser purely in order to put it away, which
  // is the one thing this plugin is careful never to do unbidden.
  it("does nothing when no browser is running at all", async () => {
    const { mode, calls } = headedFor(999 * HOUR, { running: async () => false });
    expect(await mode.autoHide(999 * HOUR)).toBeNull();
    expect(calls.filter((call) => call.startsWith("quit"))).toEqual([]);
  });

  it("reports how long the current mode has lasted", async () => {
    const { mode } = headedFor(0);
    expect(await mode.modeAgeMs(90 * 60_000)).toBe(90 * 60_000);
  });

  it("reports an unknown age as unknown rather than zero", async () => {
    const { mode } = headedFor(0, { modeSince: async () => null });
    expect(await mode.modeAgeMs(1)).toBeNull();
  });
});

describe("the threshold setting", () => {
  it("takes a number of hours", () => {
    expect(autoHideMsFrom("2")).toBe(2 * HOUR);
    expect(autoHideMsFrom(" 0.5 ")).toBe(0.5 * HOUR);
  });

  // Off has to be sayable: this closes a window, and somebody who does not
  // want that must be able to say so without inventing a huge number.
  it("can be switched off in the words a person would reach for", () => {
    expect(autoHideMsFrom("off")).toBe(0);
    expect(autoHideMsFrom("never")).toBe(0);
    expect(autoHideMsFrom("0")).toBe(0);
    expect(autoHideMsFrom("OFF")).toBe(0);
  });

  // Unusable text falls back to the default rather than to 0 (silently off,
  // the drift this ticket is about) — the same reasoning as `idleMsFrom`.
  it("falls back to the default for anything unusable", () => {
    expect(autoHideMsFrom(undefined)).toBe(DEFAULT_HEADED_HOURS * HOUR);
    expect(autoHideMsFrom("")).toBe(DEFAULT_HEADED_HOURS * HOUR);
    expect(autoHideMsFrom("soon")).toBe(DEFAULT_HEADED_HOURS * HOUR);
    expect(autoHideMsFrom("-3")).toBe(DEFAULT_HEADED_HOURS * HOUR);
  });
});

describe("saying how long", () => {
  it("reads as a person would say it", () => {
    expect(humanizeDuration(0)).toBe("0m");
    expect(humanizeDuration(59_000)).toBe("0m");
    expect(humanizeDuration(90 * 60_000)).toBe("1h 30m");
    expect(humanizeDuration(2 * HOUR)).toBe("2h");
    expect(humanizeDuration(89.68 * HOUR)).toBe("3d 17h");
    expect(humanizeDuration(48 * HOUR)).toBe("2d");
  });
});
