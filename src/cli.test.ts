import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPageHolder } from "./holder.js";
import { driverSuffix, PAGE_COMMANDS, registerCli, runCli, tabLabel } from "./cli.js";

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
    { targetId: "t1", url: "about:blank", sessionKey: null, ours: false, lastDriver: null },
    {
      targetId: "t2",
      url: "https://example.com/",
      sessionKey: "thr_me",
      ours: true,
      // A sibling spawned from thr_me drove this page more recently than thr_me
      // did — the exact shape MX-229 is about, and previously invisible here.
      lastDriver: "thr_sibling",
    },
    {
      targetId: "t3",
      url: "https://example.org/",
      sessionKey: "thr_other",
      ours: true,
      lastDriver: "thr_other",
    },
  ];
  const browser = {
    show: async () => "shown",
    hide: async () => "hidden",
    current: async () => "headless" as const,
    describe: async () => "Brave — /Applications/x (detected)",
    quit: async () => true,
    listTabs: async () => tabs,
  };

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

  // MX-229. The thread that displaced another was identified on 2026-08-21 only
  // because someone happened to run `tabs` while it was mid-task. Recording the
  // driver makes that answerable afterwards instead of by luck.
  it("names the thread that drove a tab last, when it is not the tab's own", async () => {
    const result = await runCli(fakeOperations(), "thr_me", ["tabs"], browser);
    expect(result.stdout).toContain("last driven by thr_sibling");
  });

  it("stays quiet about the driver when the tab's own thread drove it", async () => {
    // Otherwise every row on a healthy machine carries a scary-looking arrow and
    // the one row that matters stops standing out.
    const result = await runCli(fakeOperations(), "thr_me", ["tabs"], browser);
    expect(result.stdout).not.toContain("last driven by thr_other");
  });
});

describe("driverSuffix", () => {
  it("says nothing when nothing has driven the tab", () => {
    expect(driverSuffix({ url: "u", sessionKey: "thr_a", ours: true, lastDriver: null })).toBe("");
  });

  it("says nothing when the driver is the tab's own thread", () => {
    expect(driverSuffix({ url: "u", sessionKey: "thr_a", ours: true, lastDriver: "thr_a" })).toBe("");
  });

  it("names a driver that is not the tab's own thread", () => {
    expect(driverSuffix({ url: "u", sessionKey: "thr_a", ours: true, lastDriver: "thr_b" })).toContain(
      "thr_b",
    );
  });

  it("tolerates a row from a caller that does not report a driver at all", () => {
    expect(driverSuffix({ url: "u", sessionKey: "thr_a", ours: true })).toBe("");
  });
});

describe("PAGE_COMMANDS", () => {
  // The notice must not fire on the command an orchestrator runs to INVESTIGATE
  // the notice, nor on the one that reports which commit is running.
  it("covers every command that drives a page", () => {
    for (const command of ["open", "read", "snapshot", "click", "type", "eval", "screenshot", "close"]) {
      expect(PAGE_COMMANDS.has(command)).toBe(true);
    }
  });

  it("excludes the browser-level commands", () => {
    for (const command of ["tabs", "status", "show", "hide", "quit", "build"]) {
      expect(PAGE_COMMANDS.has(command)).toBe(false);
    }
  });
});

// The CLI half of MX-229. `runCli` is deliberately untouched — it is the body
// the tools share, and contention is a property of the CALLER — so the notice
// is attached here, and only here.
describe("registerCli's contention notice", () => {
  function harness(actions: Partial<Record<string, unknown>> = {}) {
    let run!: (
      argv: string[],
      ctx: { threadId: string | undefined },
    ) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
    const bb = {
      cli: { register: (spec: { run: typeof run }) => void (run = spec.run) },
    } as unknown as Parameters<typeof registerCli>[0];

    const operations = {
      open: async () => "opened",
      read: async () => "page text",
      snapshot: async () => "tree",
      click: async () => "clicked",
      type: async () => "typed",
      evaluate: async () => {
        throw new Error("page.evaluate: Execution context was destroyed");
      },
      screenshot: async () => ({ base64: "aGVsbG8=" }),
      close: async () => "closed",
      ...actions,
    };

    const store = new Map<string, unknown>();
    const holder = createPageHolder({
      kv: {
        get: async <T,>(key: string) => store.get(key) as T | undefined,
        set: async (key: string, value: unknown) => void store.set(key, value),
        delete: async (key: string) => void store.delete(key),
      },
    });

    registerCli(
      bb,
      operations as unknown as Parameters<typeof registerCli>[1],
      // MX-229's shape: every sibling collapses onto the parent's key.
      async () => "thr_parent",
      {
        listTabs: async () => [],
        mode: async () => "headless" as const,
        show: async () => "shown",
        hide: async () => "hidden",
        quit: async () => "quit",
      } as unknown as Parameters<typeof registerCli>[3],
      holder,
    );
    return { run, store };
  }

  it("prefixes a page command's output with the notice", async () => {
    const { run } = harness();
    await run(["open", "https://a.example"], { threadId: "thr_worker_a" });
    const result = await run(["read"], { threadId: "thr_worker_b" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("thr_worker_a");
    expect(result.stdout).toContain("page text");
  });

  // "Execution context was destroyed, most likely because of a navigation" is
  // what a sibling's goto looks like from inside your evaluate — so the failing
  // result is the one that most needs to say who else is on the page. Dropping
  // the notice on a non-zero exit would hide the contention in its own evidence.
  it("keeps the notice on a page command that FAILS", async () => {
    const { run } = harness();
    await run(["open", "https://a.example"], { threadId: "thr_worker_a" });
    const result = await run(["eval", "1"], { threadId: "thr_worker_b" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("thr_worker_a");
    expect(result.stderr).toContain("Execution context was destroyed");
  });

  it("says nothing on a browser-level command, which drives no page", async () => {
    const { run, store } = harness();
    await run(["open", "https://a.example"], { threadId: "thr_worker_a" });
    const result = await run(["tabs"], { threadId: "thr_worker_b" });
    expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).not.toContain("NOT YOURS ALONE");
    // And it must not steal the blame either: thr_worker_a still drove last.
    expect(store.get("holder:thr_parent")).toBe("thr_worker_a");
  });
});
