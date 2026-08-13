import { describe, expect, it } from "vitest";
import { TARGET_ID_TIMEOUT_MS, withDeadline } from "./tabs.js";

// The regression these cover: `targetIdOf` asked the browser for a tab's target
// id with no timeout at all, on every tool call, for every open tab — and it ran
// inside `tabFor`, which finishes before actions.ts arms its 20s action timeout.
// One unresponsive tab therefore hung the call indefinitely. Measured worst case
// before the fix: a 1509-second handler.

describe("withDeadline", () => {
  it("passes a value straight through when the work is prompt", async () => {
    await expect(withDeadline(Promise.resolve("t_1"), 1_000, "the browser")).resolves.toBe("t_1");
  });

  it("rejects once the work outlives the deadline", async () => {
    const never = new Promise<string>(() => {});
    await expect(withDeadline(never, 10, "the browser")).rejects.toThrow(
      "the browser did not answer within 10ms",
    );
  });

  it("names what stalled, so the log says which side is wedged", async () => {
    const never = new Promise<string>(() => {});
    await expect(withDeadline(never, 5, "tab thr_abc")).rejects.toThrow(/^tab thr_abc did not/);
  });

  it("lets the work's own rejection through unchanged", async () => {
    // A browser that answers "no" must not be reported as a stall.
    const failed = Promise.reject(new Error("Target closed"));
    await expect(withDeadline(failed, 1_000, "the browser")).rejects.toThrow("Target closed");
  });

  it("does not hold the process open after a win", async () => {
    // The timer must be cleared on the happy path too, or every tool call leaks
    // a live 5s timer and bb's event loop pays for it.
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    await withDeadline(Promise.resolve(1), 60_000, "the browser");
    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(after).toBe(before);
  });

  it("guards deadlock rather than latency", () => {
    // A local CDP round trip is sub-millisecond; this only has to beat "never".
    expect(TARGET_ID_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(TARGET_ID_TIMEOUT_MS).toBeLessThan(20_000);
  });
});
