import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerCli, runCli, tabLabel } from "./cli.js";
import { resolveSessionKey } from "./session-key.js";

function fakeOperations() {
  return {
    open: vi.fn(async () => "opened"),
    read: vi.fn(async () => "page text"),
    snapshot: vi.fn(async () => "tree"),
    click: vi.fn(async () => "clicked"),
    type: vi.fn(async () => "typed"),
    upload: vi.fn(async () => "attached"),
    evaluate: vi.fn(async () => "42"),
    screenshot: vi.fn(async () => ({ base64: "AAA" })),
    close: vi.fn(async () => "closed"),
  };
}

describe("runCli", () => {
  it("opens a url", async () => {
    const operations = fakeOperations();
    const result = await runCli(operations, "thr_a", ["open", "https://example.com"]);
    expect(operations.open).toHaveBeenCalledWith("thr_a", "https://example.com");
    expect(result.exitCode).toBe(0);
  });

  it("passes every path after the selector to upload", async () => {
    const operations = fakeOperations();
    const result = await runCli(operations, "thr_a", ["upload", "input[type=file]", "/tmp/a.pdf", "/tmp/b.pdf"]);
    expect(operations.upload).toHaveBeenCalledWith("thr_a", "input[type=file]", ["/tmp/a.pdf", "/tmp/b.pdf"]);
    expect(result.exitCode).toBe(0);
  });

  it("refuses an upload with a selector but no file", async () => {
    const operations = fakeOperations();
    const result = await runCli(operations, "thr_a", ["upload", "input[type=file]"]);
    // The selector alone is the shape a caller lands on by forgetting the
    // path, and setInputFiles([]) CLEARS the input rather than failing — so
    // the wrong thing here is a silent no-op, not an error.
    expect(operations.upload).not.toHaveBeenCalled();
    expect(result.exitCode).not.toBe(0);
  });

  it("submits when --submit is passed", async () => {
    const operations = fakeOperations();
    await runCli(operations, "thr_a", ["type", "#q", "hello", "--submit"]);
    expect(operations.type).toHaveBeenCalledWith("thr_a", "#q", "hello", true);
  });

  it("writes a screenshot to the requested path", async () => {
    const operations = fakeOperations();
    // A path under a freshly made os.tmpdir() directory, not a hardcoded
    // /tmp literal: a sandboxed test runner may not have write access to
    // /tmp directly, only to $TMPDIR (which os.tmpdir() resolves to).
    const dir = await mkdtemp(join(tmpdir(), "bb-browser-cli-test-"));
    const path = join(dir, "shot-test.png");
    try {
      const result = await runCli(operations, "thr_a", ["screenshot", path]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports an unknown subcommand without throwing", async () => {
    const result = await runCli(fakeOperations(), "thr_a", ["fly"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("fly");
  });

  it("turns an operation failure into a non-zero exit", async () => {
    const operations = fakeOperations();
    operations.click.mockRejectedValueOnce(new Error("no such element"));
    const result = await runCli(operations, "thr_a", ["click", "#gone"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no such element");
  });
});

// Each subcommand's wiring, pinned one at a time.
//
// A mutation sweep found that every one of these could be re-routed — `close`
// to `read`, `--full` inverted — with the whole suite still green, because the
// original five tests exercised three of eight subcommands. Wiring a command
// to the wrong operation produces a confident success message and does nothing,
// which is the worst failure this CLI can have.
describe("runCli subcommand wiring", () => {
  it("routes read to read, and returns what the page said", async () => {
    const operations = fakeOperations();
    const result = await runCli(operations, "thr_a", ["read"]);
    expect(operations.read).toHaveBeenCalledWith("thr_a");
    expect(operations.close).not.toHaveBeenCalled();
    expect(result.stdout).toBe("page text");
  });

  it("routes eval to evaluate, passing the expression", async () => {
    const operations = fakeOperations();
    const result = await runCli(operations, "thr_a", ["eval", "document.title"]);
    expect(operations.evaluate).toHaveBeenCalledWith("thr_a", "document.title");
    expect(result.stdout).toBe("42");
  });

  it("routes close to close — never to a read that would report false success", async () => {
    const operations = fakeOperations();
    const result = await runCli(operations, "thr_a", ["close"]);
    expect(operations.close).toHaveBeenCalledWith("thr_a");
    expect(operations.read).not.toHaveBeenCalled();
    expect(result.stdout).toBe("closed");
  });

  it("routes click to click, passing the selector", async () => {
    const operations = fakeOperations();
    await runCli(operations, "thr_a", ["click", "#submit"]);
    expect(operations.click).toHaveBeenCalledWith("thr_a", "#submit");
  });
});

describe("runCli flags and defaults", () => {
  it("snapshots the interactive tree by default", async () => {
    const operations = fakeOperations();
    await runCli(operations, "thr_a", ["snapshot"]);
    expect(operations.snapshot).toHaveBeenCalledWith("thr_a", true);
  });

  it("snapshots the full tree only when --full is passed", async () => {
    const operations = fakeOperations();
    await runCli(operations, "thr_a", ["snapshot", "--full"]);
    expect(operations.snapshot).toHaveBeenCalledWith("thr_a", false);
  });

  it("does not submit unless --submit is passed", async () => {
    const operations = fakeOperations();
    await runCli(operations, "thr_a", ["type", "#q", "hello"]);
    expect(operations.type).toHaveBeenCalledWith("thr_a", "#q", "hello", false);
  });
});

describe("runCli usage errors", () => {
  it.each([
    { argv: ["open"], missing: "url", op: "open" as const },
    { argv: ["click"], missing: "selector", op: "click" as const },
    { argv: ["eval"], missing: "expression", op: "evaluate" as const },
    { argv: ["type", "#q"], missing: "text", op: "type" as const },
  ])("refuses $argv with no $missing, and calls nothing", async ({ argv, op }) => {
    const operations = fakeOperations();
    const result = await runCli(operations, "thr_a", argv);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("usage:");
    expect(operations[op]).not.toHaveBeenCalled();
  });

  it("treats an empty selector as missing rather than passing it through", async () => {
    const operations = fakeOperations();
    const result = await runCli(operations, "thr_a", ["click", ""]);
    expect(result.exitCode).toBe(1);
    expect(operations.click).not.toHaveBeenCalled();
  });
});

// The listing bug a thread reported on 2026-08-12: it ran `browser_open`,
// its page loaded, and `bb browser tabs` then showed BOTH its own bound row
// and a row labelled "yours" on about:blank. Nothing was wrong with the
// driving — `eval` hit the right page — but "yours" is the most authoritative
// label in that output, and it was attached to the browser's own startup tab.
// The reasonable reading, "my navigation failed", was exactly backwards.
describe("tabLabel", () => {
  const blank = { url: "about:blank", sessionKey: null, ours: false };

  it("names the browser's startup tab instead of blaming a human for it", () => {
    expect(tabLabel(blank, "thr_me")).toBe("(browser startup tab)");
  });

  it("never says 'yours' — the plugin cannot know whose an unbound tab is", () => {
    const foreign = { url: "https://example.com/", sessionKey: null, ours: false };
    expect(tabLabel(foreign, "thr_me")).toBe("(not opened by bb)");
    expect(tabLabel(foreign, "thr_me")).not.toMatch(/yours/i);
    expect(tabLabel(blank, "thr_me")).not.toMatch(/yours/i);
  });

  it("marks the caller's own row so it need not be found by matching an id by eye", () => {
    const mine = { url: "https://example.com/", sessionKey: "thr_me", ours: true };
    expect(tabLabel(mine, "thr_me")).toBe("thr_me (this thread)");
  });

  it("names another thread by its id, unmarked", () => {
    const theirs = { url: "https://example.com/", sessionKey: "thr_other", ours: true };
    expect(tabLabel(theirs, "thr_me")).toBe("thr_other");
  });

  it("distinguishes an agent tab that lost its binding from one we never opened", () => {
    expect(tabLabel({ url: "https://example.com/", sessionKey: null, ours: true }, "thr_me")).toBe(
      "(agent tab, unbound)",
    );
  });
});

describe("bb browser tabs and status", () => {
  const tabs = [
    { targetId: "t1", url: "about:blank", sessionKey: null, ours: false },
    {
      targetId: "t2",
      url: "https://example.com/",
      sessionKey: "thr_me",
      ours: true,
    },
    {
      targetId: "t3",
      url: "https://example.org/",
      sessionKey: "thr_other",
      ours: true,
    },
  ];
  const browser = {
    show: async () => "shown",
    hide: async () => "hidden",
    current: async () => "headless" as const,
    describe: async () => "Brave — /Applications/x (detected)",
    quit: async () => true,
    listTabs: async () => tabs,
    modeAgeMs: async () => 90 * 60_000,
    lastAutoHide: async () => null,
  };

  const headedBrowser = (overrides: Record<string, unknown> = {}) => ({
    ...browser,
    current: async () => "headed" as const,
    ...overrides,
  });

  // MX-297. Headed is the state that drifts — measured at 69h and 90h on two
  // occasions, against every real human takeover ending inside 193 seconds. A
  // mode with no clock on it is how nobody noticed, so `status` carries one.
  it("says how long the browser has been on screen", async () => {
    const result = await runCli(fakeOperations(), "thr_me", ["status"], headedBrowser());
    expect(result.stdout).toContain("headed for 1h 30m");
  });

  // Headless is not an exposure and has no clock worth reading; a duration on
  // both would make the line about uptime instead of about risk.
  it("says nothing about duration when it is headless", async () => {
    const result = await runCli(fakeOperations(), "thr_me", ["status"], browser);
    expect(result.stdout).toContain("headless,");
    expect(result.stdout).not.toContain(" for ");
  });

  it("does not invent a duration it cannot know", async () => {
    const result = await runCli(
      fakeOperations(),
      "thr_me",
      ["status"],
      headedBrowser({ modeAgeMs: async () => null }),
    );
    expect(result.stdout).toContain("headed,");
    expect(result.stdout).not.toContain("for null");
  });

  // The whole price of a wrong automatic hide is whether the human meets an
  // unexplained vanished window or an explained one. The log is not where he
  // looks; this is.
  it("reports an automatic return to headless, where a person would find it", async () => {
    const result = await runCli(
      fakeOperations(),
      "thr_me",
      ["status"],
      browser2AutoHidden(),
    );
    expect(result.stdout).toContain("put back automatically");
    expect(result.stdout).toContain("bb browser show");
  });

  function browser2AutoHidden() {
    return {
      ...browser,
      lastAutoHide: async () =>
        "put back automatically after 3d 17h on screen — `bb browser show` brings it back",
    };
  }

  it("lists every tab without claiming the startup tab belongs to anyone", async () => {
    const result = await runCli(fakeOperations(), "thr_me", ["tabs"], browser);
    expect(result.stdout).toContain("(browser startup tab)");
    expect(result.stdout).toContain("thr_me (this thread)");
    expect(result.stdout).toContain("thr_other");
    expect(result.stdout).not.toMatch(/yours/i);
  });

  it("accounts for every open tab in status, so none reads as a stray", async () => {
    const result = await runCli(fakeOperations(), "thr_me", ["status"], browser);
    expect(result.stdout).toContain("3 tab(s)");
    expect(result.stdout).toContain("2 opened by agents");
    expect(result.stdout).toContain("1 browser startup");
    expect(result.stdout).toContain("0 not ours");
  });

  it("says which browser is being driven — the question behind most confusion", async () => {
    const result = await runCli(fakeOperations(), "thr_me", ["status"], browser);
    expect(result.stdout).toContain("Brave — /Applications/x (detected)");
  });
});

// MX-1080: the CLI resolves a page the same way the tools do — the calling
// thread's own id — so a worker and its operator never land on one tab.
describe("registerCli's session key", () => {
  it("drives each calling thread's own tab, and scratch outside a thread", async () => {
    let run!: (argv: string[], ctx: { threadId: string | undefined }) => Promise<unknown>;
    const bb = {
      cli: { register: (spec: { run: typeof run }) => void (run = spec.run) },
    } as unknown as Parameters<typeof registerCli>[0];
    const opened: string[] = [];
    const operations = {
      open: async (sessionKey: string) => {
        opened.push(sessionKey);
        return "opened";
      },
    } as unknown as Parameters<typeof registerCli>[1];
    registerCli(bb, operations, resolveSessionKey, {} as Parameters<typeof registerCli>[3]);

    await run(["open", "https://a.example"], { threadId: "thr_operator" });
    await run(["open", "https://a.example"], { threadId: "thr_worker" });
    await run(["open", "https://a.example"], { threadId: undefined });
    expect(opened).toEqual(["thr_operator", "thr_worker", "scratch"]);
  });
});
