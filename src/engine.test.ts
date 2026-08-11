import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEngine } from "./engine.js";
import { fakeAgentBrowser } from "./test-support/fake-agent-browser.js";

function engineWith(stdout?: string) {
  const binary = fakeAgentBrowser(stdout);
  const dataDir = mkdtempSync(join(tmpdir(), "bb-browser-data-"));
  const engine = createEngine({ dataDir: async () => dataDir, log: () => {}, binary: binary.path });
  return { binary, dataDir, engine };
}

describe("engine.run", () => {
  it("always isolates the namespace", async () => {
    const { binary, engine } = engineWith();
    await engine.run({ profile: "main", session: "thr_a", argv: ["get", "url"] });
    expect(binary.calls()[0]).toContain("--namespace");
    expect(binary.calls()[0]).toContain("bb-plugin-browser");
  });

  it("passes the anti-detection launch arg on every call", async () => {
    const { binary, engine } = engineWith();
    await engine.run({ profile: "main", session: "thr_a", argv: ["get", "url"] });
    expect(binary.calls()[0].join(" ")).toContain(
      "--disable-blink-features=AutomationControlled",
    );
  });

  it("puts the profile directory under the plugin data dir", async () => {
    const { binary, dataDir, engine } = engineWith();
    await engine.run({ profile: "main", session: "thr_a", argv: ["get", "url"] });
    expect(binary.calls()[0].join(" ")).toContain(
      join(dataDir, "plugins", "browser", "profiles", "main"),
    );
  });

  it("names the session so two threads never share a page", async () => {
    const { binary, engine } = engineWith();
    await engine.run({ profile: "main", session: "thr_a", argv: ["get", "url"] });
    await engine.run({ profile: "main", session: "thr_b", argv: ["get", "url"] });
    expect(binary.calls()[0]).toContain("thr_a");
    expect(binary.calls()[1]).toContain("thr_b");
  });

  it("adds --headed only when asked", async () => {
    const { binary, engine } = engineWith();
    await engine.run({ profile: "main", session: "s", argv: ["get", "url"] });
    await engine.run({ profile: "main", session: "s", argv: ["get", "url"], headed: true });
    expect(binary.calls()[0]).not.toContain("--headed");
    expect(binary.calls()[1]).toContain("--headed");
  });

  it("returns stdout and the exit code", async () => {
    const { engine } = engineWith("https://example.com/");
    const result = await engine.run({ profile: "main", session: "s", argv: ["get", "url"] });
    expect(result.stdout.trim()).toBe("https://example.com/");
    expect(result.code).toBe(0);
  });

  it("resolves the dataDir thunk lazily and caches it", async () => {
    const binary = fakeAgentBrowser();
    const dataDir = mkdtempSync(join(tmpdir(), "bb-browser-data-"));
    let calls = 0;
    const countingDataDir = async () => {
      calls += 1;
      return dataDir;
    };
    const engine = createEngine({ dataDir: countingDataDir, log: () => {}, binary: binary.path });
    expect(calls).toBe(0);
    await engine.run({ profile: "main", session: "s", argv: ["get", "url"] });
    expect(calls).toBe(1);
    await engine.run({ profile: "main", session: "s", argv: ["get", "url"] });
    expect(calls).toBe(1);
  });
});

describe("engine.browserCdpUrl", () => {
  it("reads the websocket agent-browser prints", async () => {
    const { engine } = engineWith(
      "ws://127.0.0.1:58466/devtools/browser/b2567744-e93e-4ca4-ada5-8b06b95f08ae\n",
    );
    await expect(engine.browserCdpUrl("main")).resolves.toBe(
      "ws://127.0.0.1:58466/devtools/browser/b2567744-e93e-4ca4-ada5-8b06b95f08ae",
    );
  });

  it("rejects when the output is not a websocket url", async () => {
    const { engine } = engineWith("no browser running");
    await expect(engine.browserCdpUrl("main")).rejects.toThrow(/cdp/i);
  });
});
