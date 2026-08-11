import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { controlSessionFor, createEngine } from "./engine.js";
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

  it("omits --profile and --args when attaching to an already-running browser", async () => {
    // A valid ws:// stdout so the attach's ensure-first-use step (a
    // launch-mode cdp-url call) succeeds and doesn't mask this assertion.
    const { binary, engine } = engineWith("ws://127.0.0.1:9222/devtools/browser/abc\n");
    await engine.run({
      profile: "main",
      session: "thr_a",
      argv: ["get", "url"],
      attach: true,
    });
    // calls[0] is the ensure step's launch-mode cdp-url call; calls[1] is
    // the actual attach invocation under test here.
    const call = binary.calls()[1];
    expect(call).not.toContain("--profile");
    expect(call).not.toContain("--args");
    expect(call.join(" ")).not.toContain("--disable-blink-features=AutomationControlled");
    expect(call).toContain("--namespace");
    expect(call).toContain("bb-plugin-browser");
    expect(call).toContain("thr_a");
  });

  it("passes --profile when not attaching, exactly as a launch does today", async () => {
    const { binary, dataDir, engine } = engineWith();
    await engine.run({ profile: "main", session: "thr_a", argv: ["get", "url"] });
    const call = binary.calls()[0];
    expect(call).toContain("--profile");
    expect(call.join(" ")).toContain(join(dataDir, "plugins", "browser", "profiles", "main"));
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

describe("engine.shutdown", () => {
  it("closes only that profile's own control session, never --all", async () => {
    const { binary, engine } = engineWith();
    await engine.run({ profile: "main", session: "thr_a", argv: ["get", "url"] });
    await engine.shutdown("main");
    const closeCall = binary.calls().at(-1) ?? [];
    expect(closeCall).not.toContain("--all");
    expect(closeCall).toContain(controlSessionFor("main"));
  });

  it("leaves another profile's browser alone", async () => {
    const { binary, engine } = engineWith();
    await engine.run({ profile: "main", session: "thr_a", argv: ["get", "url"] });
    await engine.run({ profile: "other", session: "thr_b", argv: ["get", "url"] });
    await engine.shutdown("main");
    const namesOtherControlSession = binary
      .calls()
      .some((call) => call.includes(controlSessionFor("other")));
    expect(namesOtherControlSession).toBe(false);
  });
});

describe("engine.shutdownAll", () => {
  it("closes each live profile individually, and is a no-op once nothing is live", async () => {
    const { binary, engine } = engineWith();
    await engine.run({ profile: "main", session: "thr_a", argv: ["get", "url"] });
    await engine.run({ profile: "other", session: "thr_b", argv: ["get", "url"] });
    const callsBeforeShutdown = binary.calls().length;

    await engine.shutdownAll();
    const closeCalls = binary.calls().slice(callsBeforeShutdown);
    expect(closeCalls).toHaveLength(2);
    expect(closeCalls.some((call) => call.includes(controlSessionFor("main")))).toBe(true);
    expect(closeCalls.some((call) => call.includes(controlSessionFor("other")))).toBe(true);

    const callsBeforeSecondShutdown = binary.calls().length;
    await engine.shutdownAll();
    expect(binary.calls().length).toBe(callsBeforeSecondShutdown);
  });
});

describe("engine.run attach ensures a browser first", () => {
  it("triggers a launch-mode get cdp-url before the first attach for a profile", async () => {
    const { binary, engine } = engineWith("ws://127.0.0.1:9222/devtools/browser/abc\n");
    await engine.run({ profile: "main", session: "thr_a", argv: ["get", "url"], attach: true });
    const calls = binary.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("cdp-url");
    expect(calls[0]).toContain("--profile");
    expect(calls[1]).not.toContain("--profile");
    expect(calls[1]).toContain("thr_a");
  });

  it("does not re-ensure on a second attach for the same profile", async () => {
    const { binary, engine } = engineWith("ws://127.0.0.1:9222/devtools/browser/abc\n");
    await engine.run({ profile: "main", session: "thr_a", argv: ["get", "url"], attach: true });
    expect(binary.calls()).toHaveLength(2);
    await engine.run({ profile: "main", session: "thr_b", argv: ["get", "url"], attach: true });
    const calls = binary.calls();
    expect(calls).toHaveLength(3);
    expect(calls.filter((call) => call.includes("cdp-url"))).toHaveLength(1);
  });

  it("re-ensures after shutdown clears the profile", async () => {
    const { binary, engine } = engineWith("ws://127.0.0.1:9222/devtools/browser/abc\n");
    await engine.run({ profile: "main", session: "thr_a", argv: ["get", "url"], attach: true });
    await engine.shutdown("main");
    await engine.run({ profile: "main", session: "thr_b", argv: ["get", "url"], attach: true });
    const cdpUrlCalls = binary.calls().filter((call) => call.includes("cdp-url"));
    expect(cdpUrlCalls).toHaveLength(2);
  });
});
