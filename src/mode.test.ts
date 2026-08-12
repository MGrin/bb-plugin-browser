import { describe, expect, it, vi } from "vitest";
import { createModeSwitch, type ModeDeps } from "./mode.js";

function switchWith(overrides: Partial<ModeDeps> = {}) {
  const calls: string[] = [];
  const state = { mode: "headless" as "headless" | "headed" };
  const deps: ModeDeps = {
    currentMode: async () => state.mode,
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
