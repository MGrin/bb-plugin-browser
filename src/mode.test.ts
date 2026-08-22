import { describe, expect, it, vi } from "vitest";
import {
  autoHideMsFrom,
  createModeSwitch,
  DEFAULT_HEADED_HOURS,
  humanizeDuration,
  type ModeDeps,
  type OpenTab,
} from "./mode.js";

const HOUR = 3_600_000;

/**
 * A fake browser that SESSION-RESTORES, because that is the mechanism the
 * switch has to cope with (MX-306). On relaunch every page comes back with a
 * NEW target id, bound to nobody and owned by nobody — which is exactly what
 * Chromium does with the profile's tabs, and the reason a naive restore opened
 * a second copy of every page.
 */
function switchWith(overrides: Partial<ModeDeps> = {}) {
  const calls: string[] = [];
  const state = {
    mode: "headless" as "headless" | "headed",
    tabs: [
      { targetId: "t1", url: "https://example.com/", sessionKey: "thr_a", ours: true },
      { targetId: "t2", url: "about:blank", sessionKey: "thr_blank", ours: true },
    ] as OpenTab[],
  };
  /** What a relaunch does to the tabs: everything back, nothing bound. */
  const sessionRestore = () => {
    state.tabs = state.tabs.map((tab, index) => ({
      targetId: `r${index}`,
      url: tab.url,
      sessionKey: null,
      ours: false,
    }));
  };
  const deps: ModeDeps = {
    currentMode: async () => state.mode,
    running: async () => true,
    modeSince: async () => 0,
    autoHideAfterMs: async () => DEFAULT_HEADED_HOURS * HOUR,
    busy: () => false,
    openTabs: async () => state.tabs.map((tab) => ({ ...tab })),
    quit: async () => {
      calls.push("quit");
      return true;
    },
    relaunch: async (mode) => {
      calls.push(`relaunch ${mode}`);
      state.mode = mode;
      sessionRestore();
    },
    adopt: async (sessionKey, targetId) => {
      calls.push(`adopt ${sessionKey} ${targetId}`);
      const tab = state.tabs.find((candidate) => candidate.targetId === targetId);
      if (!tab) throw new Error(`no such tab ${targetId}`);
      tab.sessionKey = sessionKey;
      tab.ours = true;
    },
    restore: async (sessionKey, url) => {
      calls.push(`restore ${sessionKey} ${url}`);
      state.tabs.push({ targetId: `n${state.tabs.length}`, url, sessionKey, ours: true });
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
      // ADOPTED, not reopened: the browser already brought the page back.
      "adopt thr_a r0",
    ]);
    expect(message).toContain("on screen");
  });

  // A blank tab restored is still a blank tab; reopening it only costs time.
  it("does not restore pages that were never anywhere", async () => {
    const { mode, calls } = switchWith();
    await mode.show();
    expect(calls.filter((call) => call.includes("thr_blank"))).toEqual([]);
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
      openTabs: async () => {
        order.push("read the tabs");
        return [
          { targetId: "t1", url: "https://example.com/", sessionKey: "thr_a", ours: true },
        ];
      },
      quit: async () => {
        order.push("quit");
        return true;
      },
    });
    await mode.show();
    expect(order.slice(0, 2)).toEqual(["read the tabs", "quit"]);
  });

  it("restores the rest when one page fails to come back", async () => {
    const restored: string[] = [];
    const { mode } = switchWith({
      openTabs: async () => [
        { targetId: "t1", url: "https://a.example/", sessionKey: "thr_a", ours: true },
        { targetId: "t2", url: "https://b.example/", sessionKey: "thr_b", ours: true },
      ],
      // A browser that restored nothing, so both pages go down the reopen path.
      relaunch: async () => {},
      restore: async (sessionKey) => {
        if (sessionKey === "thr_a") throw new Error("gone");
        restored.push(sessionKey);
      },
    });
    const message = await mode.show();
    expect(restored).toEqual(["thr_b"]);
    expect(message).toContain("1 of 2");
  });

  // THE DEFECT MX-306 IS ABOUT. A switch is a relaunch, and Chromium
  // session-restores the profile's pages — so the agent's page is already back
  // before `restore` runs. Opening it again left a second copy that was
  // `ours: false` and bound to nobody, which the reaper skips by the very rule
  // that protects a human's tab. One orphan per agent tab per switch, forever.
  it("adopts the page the browser restored instead of opening a second copy", async () => {
    const { mode, calls, state } = switchWith();
    await mode.show();
    expect(calls.filter((call) => call.startsWith("restore"))).toEqual([]);
    expect(calls).toContain("adopt thr_a r0");
    const example = state.tabs.filter((tab) => tab.url === "https://example.com/");
    expect(example).toHaveLength(1);
    expect(example[0]).toMatchObject({ sessionKey: "thr_a", ours: true });
  });

  // Adoption is an optimisation over reopening, never a requirement: a browser
  // that restores nothing (the setting can be turned off) must still put every
  // thread back.
  it("opens the page itself when the browser restored nothing", async () => {
    const { mode, calls } = switchWith({ relaunch: async () => {} });
    await mode.show();
    expect(calls).toContain("restore thr_a https://example.com/");
  });

  // THE ARM THE FIX IS NOT ABOUT, and the one an ownership bug would hide in.
  // Adoption takes an unbound, unowned page — which after a relaunch is what a
  // HUMAN's restored tab looks like too. It is only ever matched by url, so a
  // tab of his at a url no agent had is never a candidate.
  it("never adopts a tab the plugin did not open", async () => {
    const { mode, state } = switchWith({});
    state.tabs.push({
      targetId: "h1",
      url: "https://workspace.example/",
      sessionKey: null,
      ours: false,
    });
    await mode.show();
    const his = state.tabs.filter((tab) => tab.url === "https://workspace.example/");
    expect(his).toHaveLength(1);
    expect(his[0]).toMatchObject({ sessionKey: null, ours: false });
  });

  // And when he is on the SAME url as an agent, one restored page is reserved
  // for him before any adoption happens — so a relaunch that brought back only
  // his copy reopens the agent's rather than taking his. Without the
  // reservation this adopts his page, and the reaper becomes eligible to close
  // it later, which is the whole hazard.
  it("reserves a restored page for each tab that was not ours", async () => {
    const { mode, calls, state } = switchWith({
      openTabs: async () => state.tabs.map((tab) => ({ ...tab })),
      relaunch: async () => {
        // Only the human's copy came back.
        state.tabs = [
          { targetId: "r0", url: "https://example.com/", sessionKey: null, ours: false },
        ];
      },
    });
    state.tabs = [
      { targetId: "t1", url: "https://example.com/", sessionKey: "thr_a", ours: true },
      { targetId: "h1", url: "https://example.com/", sessionKey: null, ours: false },
    ];
    await mode.show();
    expect(calls.filter((call) => call.startsWith("adopt"))).toEqual([]);
    expect(calls).toContain("restore thr_a https://example.com/");
    expect(state.tabs.find((tab) => tab.targetId === "r0")).toMatchObject({
      sessionKey: null,
      ours: false,
    });
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
    expect(calls).toContain("adopt thr_a r0");
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
