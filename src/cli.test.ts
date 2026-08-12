import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";

function fakeOperations() {
  return {
    open: vi.fn(async () => "opened"),
    read: vi.fn(async () => "page text"),
    snapshot: vi.fn(async () => "tree"),
    click: vi.fn(async () => "clicked"),
    type: vi.fn(async () => "typed"),
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
