import { describe, expect, it, vi } from "vitest";
import { goto, GOTO_TIMEOUT_MS, mxBin, type Runner } from "./goto.js";

const report = (fields: Record<string, unknown>) =>
  JSON.stringify({ rc: 0, status: "done", evidence: null, history: [], ...fields });

function fake(stdout: string, code: number | null = 0, stderr = "") {
  return vi.fn<Runner>(async () => ({ code, stdout, stderr }));
}

describe("goto", () => {
  it("launches exactly `mx jev browser run --goal --url --keep-tab --json`, by absolute path", async () => {
    const run = fake(report({}));
    await goto(run, "thr_a", "-starts with a dash", "https://example.com/", { HOME: "/h" });
    const [argv, , timeout] = run.mock.calls[0];
    expect(argv).toEqual([
      mxBin({ HOME: "/h" }),
      "jev",
      "browser",
      "run",
      "--goal",
      "-starts with a dash",
      "--url",
      "https://example.com/",
      "--keep-tab",
      "--json",
    ]);
    expect(argv[0]).toMatch(/\/\.local\/bin\/mx$/);
    expect(timeout).toBe(GOTO_TIMEOUT_MS);
  });

  it("outlasts mx's own 300 s budget and 20 s close grace", () => {
    expect(GOTO_TIMEOUT_MS).toBeGreaterThan(320_000);
  });

  it("honours MX_BIN", () => {
    expect(mxBin({ MX_BIN: "/opt/mx" })).toBe("/opt/mx");
  });

  it("hands mx the caller's thread as BB_THREAD_ID", async () => {
    const run = fake(report({}));
    await goto(run, "thr_a", "g", "https://example.com/", { PATH: "/usr/bin" });
    expect(run.mock.calls[0][1]).toEqual({ PATH: "/usr/bin", BB_THREAD_ID: "thr_a" });
  });

  it("sets no BB_THREAD_ID outside a thread, rather than a made-up one", async () => {
    const run = fake(report({}));
    await goto(run, undefined, "g", "https://example.com/", { PATH: "/usr/bin" });
    expect(run.mock.calls[0][1]).toEqual({ PATH: "/usr/bin" });
  });

  it("renders status, evidence, steps and clicks from the report", async () => {
    const run = fake(
      report({
        evidence: { check: "postcondition" },
        history: ["step 1: clicked Invoices", "step 2: clicked INV-42"],
        attribution: { attempted: 2, confirmed: 2 },
      }),
    );
    const out = await goto(run, "thr_a", "g", "https://example.com/");
    expect(out).toContain("status: done (rc 0)");
    expect(out).toContain('evidence: {"check":"postcondition"}');
    expect(out).toContain("  step 2: clicked INV-42");
    expect(out).toContain("clicks: 2 attempted, 2 confirmed");
    expect(out).toContain("closed its tab");
  });

  it("reports a stop with its rc, not as success", async () => {
    const run = fake(report({ rc: 75, status: "budget" }), 75);
    const out = await goto(run, "thr_a", "g", "https://example.com/");
    expect(out.split("\n")[0]).toBe("status: budget (rc 75)");
  });

  it("names typed fields when the run typed any", async () => {
    const run = fake(
      report({ attribution: { attempted: 1, confirmed: 1, typed: { attempted: 1, confirmed: 0 } } }),
    );
    const out = await goto(run, "thr_a", "g", "https://example.com/");
    expect(out).toContain("typed into 1 field(s), 0 confirmed");
  });

  it("reads the report off the LAST json line, past any other output", async () => {
    const run = fake(`noise\n${report({ status: "likely_done", rc: 75 })}\n${report({ status: "stop", rc: 75 })}\n`);
    const out = await goto(run, "thr_a", "g", "https://example.com/");
    expect(out.split("\n")[0]).toBe("status: stop (rc 75)");
  });

  it("says blind, with the exit and the error, when mx printed no report", async () => {
    const run = fake("", 2, "mx jev browser run: blind: no TypeSafe client\n");
    const out = await goto(run, "thr_a", "g", "https://example.com/");
    expect(out).toMatch(/^status: blind/);
    expect(out).toContain("exit 2");
    expect(out).toContain("no TypeSafe client");
    expect(out).toContain("may still be open");
  });

  it("passes a blind run's stderr reason through, since the report carries none", async () => {
    const run = fake(
      report({ rc: 2, status: "blind", history: ["step 1: clicked e451 `Moon`"] }),
      2,
      "mx jev browser run: blind: step 2: snapshot: the 54 parts do not rejoin as JSON\n",
    );
    const out = await goto(run, "thr_a", "g", "https://example.com/");
    expect(out).toContain("why: mx jev browser run: blind: step 2: snapshot");
  });

  it("adds no reason line to a run that is not blind", async () => {
    const run = fake(report({ status: "done" }), 0, "some warning\n");
    const out = await goto(run, "thr_a", "g", "https://example.com/");
    expect(out).not.toContain("why:");
  });

  it("says killed when mx was killed with no exit code", async () => {
    const run = fake("", null, "");
    const out = await goto(run, "thr_a", "g", "https://example.com/");
    expect(out).toContain("exit killed");
  });

  // MX-1346. The control for each arm is the one beside it: the same report without
  // `tab: "kept"` must still say the tab was closed, and never claim a url.
  describe("the tab line", () => {
    const probe = () => vi.fn(async () => "https://example.com/invoices/42");

    it("names the url the kept tab is on, read from the tab, and says not to re-open", async () => {
      const currentUrl = probe();
      const out = await goto(
        fake(report({ tab: "kept" })), "thr_a", "g", "https://example.com/", {}, currentUrl,
      );
      expect(out).toContain("final url: https://example.com/invoices/42");
      expect(out).toContain("still open");
      expect(out).toContain("do not browser_open it again");
      expect(out).not.toContain("closed its tab");
      expect(currentUrl).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["closed by the run", { tab: "closed" }],
      ["a report that names no tab (pre-loop failure, or an older mx)", {}],
    ])("says the tab was closed and never reads a url: %s", async (_name, fields) => {
      const currentUrl = probe();
      const out = await goto(
        fake(report(fields)), "thr_a", "g", "https://example.com/", {}, currentUrl,
      );
      expect(out).toContain("The run closed its tab when it ended.");
      expect(out).not.toContain("final url");
      expect(currentUrl).not.toHaveBeenCalled();
    });

    it("says the tab is open but unread when the url cannot be read, rather than throwing", async () => {
      const out = await goto(
        fake(report({ tab: "kept" })), "thr_a", "g", "https://example.com/", {},
        async () => { throw new Error("page crashed"); },
      );
      expect(out).toContain("left this thread's tab open");
      expect(out).toContain("page crashed");
      expect(out).not.toContain("final url");
    });
  });
});
