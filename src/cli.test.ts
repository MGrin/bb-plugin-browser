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
    const result = await runCli(operations, "thr_a", ["screenshot", "/tmp/shot-test.png"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/tmp/shot-test.png");
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
