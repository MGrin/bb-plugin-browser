// The wiring, tested as wiring.
//
// server.ts had zero coverage, and the review that found that proved it the
// only way worth proving: it reverted BOTH shutdown call sites to their
// pre-fix form — `engine.shutdown` / `engine.shutdownAll` instead of the
// `pages.*` pair that also forgets where the browser was — and the suite
// stayed green at 242/242. So the wiring half of a security-relevant fix
// (a remembered address outlives its browser, points at a freed ephemeral
// port, and the next process to take that port is somebody else's browser)
// was undefended, as was the whole `settings.onChange` handler, which is
// real logic and not declaration.
//
// Nothing here mocks the plugin's own modules. The engine, the registry,
// the pages and the reaper are all the real ones; what is faked is the bb
// host, plus `agent-browser` itself, which is a shell script on PATH that
// records its argv. So "the browser was closed" is asserted as an actual
// invocation, and "we forgot where it was" as an actual kv row.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BbPluginApi } from "@bb/plugin-sdk";
import plugin from "./server.js";
import { memoryKv } from "./src/test-support/memory-kv.js";

/** A fake `agent-browser` on PATH, recording every invocation. */
function fakeBinaryOnPath() {
  const dir = mkdtempSync(join(tmpdir(), "bb-browser-server-test-"));
  const logPath = join(dir, "calls.log");
  const binPath = join(dir, "agent-browser");
  writeFileSync(
    binPath,
    ["#!/bin/sh", `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`, "printf 'ok'", ""].join("\n"),
    "utf8",
  );
  chmodSync(binPath, 0o755);
  return {
    dir,
    calls: () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8").split("\n").filter(Boolean)
        : [],
  };
}

type SettingsShape = { headed: boolean; idleMinutes: string };

function fakeBb() {
  const kv = memoryKv();
  const dataDir = mkdtempSync(join(tmpdir(), "bb-browser-server-data-"));
  const settings: SettingsShape = { headed: false, idleMinutes: "30" };
  const onChangeHandlers: ((next: SettingsShape, previous: SettingsShape) => void)[] = [];
  const services = new Map<string, (signal: AbortSignal) => Promise<void>>();
  const events = new Map<string, ((payload: unknown) => unknown)[]>();
  const disposers: (() => Promise<void> | void)[] = [];
  const routes: { method: string; path: string; auth?: string }[] = [];
  const tools: string[] = [];
  const logs: string[] = [];
  let configured: unknown;
  let cliName: string | undefined;
  let rpcRegistered = false;

  const bb = {
    pluginId: "browser",
    log: {
      info: (message: string) => logs.push(`info ${message}`),
      warn: (message: string) => logs.push(`warn ${message}`),
      error: (message: string) => logs.push(`error ${message}`),
      debug: () => {},
    },
    settings: {
      define: () => ({
        get: async () => ({ ...settings }),
        onChange: (handler: (next: SettingsShape, previous: SettingsShape) => void) => {
          onChangeHandlers.push(handler);
        },
      }),
    },
    storage: { kv },
    sdk: {
      system: { config: async () => ({ dataDir }) },
      plugins: { token: async () => ({ token: "tok" }) },
      // A thread with no parent, so the session key resolves to the thread
      // itself. (A host answering `null` here — a thread.deleted event for a
      // row already gone — used to throw a TypeError out of the resolver;
      // session-key.ts now treats it as an unreadable thread, covered in
      // src/session-key.test.ts.)
      threads: { get: async () => ({ parentThreadId: null, childOrigin: null }) },
    },
    http: {
      route: (method: string, path: string, _handler: unknown, opts?: { auth?: string }) => {
        routes.push({ method, path, auth: opts?.auth });
      },
    },
    rpc: {
      register: () => {
        rpcRegistered = true;
      },
    },
    agents: {
      registerTool: ({ name }: { name: string }) => tools.push(name),
      configure: (factory: () => unknown) => {
        configured = factory();
      },
    },
    cli: {
      register: ({ name }: { name: string }) => {
        cliName = name;
      },
    },
    background: {
      service: (name: string, { start }: { start: (signal: AbortSignal) => Promise<void> }) => {
        services.set(name, start);
      },
    },
    events: {
      on: (name: string, handler: (payload: unknown) => unknown) => {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
    },
    onDispose: (handler: () => Promise<void> | void) => disposers.push(handler),
  } as unknown as BbPluginApi;

  return {
    bb,
    kv,
    settings,
    logs,
    routes,
    tools,
    services,
    events,
    /** Fire the settings.onChange handlers the plugin registered. */
    changeSettings(next: Partial<SettingsShape>) {
      const previous = { ...settings };
      Object.assign(settings, next);
      for (const handler of onChangeHandlers) handler({ ...settings }, previous);
    },
    dispose: async () => {
      for (const handler of disposers) await handler();
    },
    get configured() {
      return configured;
    },
    get cliName() {
      return cliName;
    },
    get rpcRegistered() {
      return rpcRegistered;
    },
  };
}

/** Poll until a condition holds — `onChange` is deliberately fire-and-forget. */
async function until(predicate: () => boolean, what: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let binary: ReturnType<typeof fakeBinaryOnPath>;
let originalPath: string | undefined;

beforeEach(() => {
  binary = fakeBinaryOnPath();
  originalPath = process.env.PATH;
  // The engine spawns `agent-browser` by name. Shadowing it for the length
  // of a test is what keeps this from touching a real browser — including
  // mgrin's own agent-browser sessions, which live in another namespace but
  // on the same machine.
  process.env.PATH = `${binary.dir}:${originalPath ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("the plugin's wiring", () => {
  it("registers every surface it claims to", async () => {
    const host = fakeBb();
    await plugin(host.bb);

    expect(host.routes).toEqual([{ method: "GET", path: "/stream", auth: "token" }]);
    expect(host.tools).toContain("browser_open");
    expect(host.tools).toHaveLength(8);
    // A configure() return is accepted or rejected WHOLE, so naming a skill
    // the manifest cannot resolve would silently drop all eight tools too.
    expect(host.configured).toEqual({ tools: expect.arrayContaining(["browser_open"]), skills: ["browser"] });
    expect(host.cliName).toBe("browser");
    expect(host.rpcRegistered).toBe(true);
    expect(host.services.has("reaper")).toBe(true);
    expect([...host.events.keys()].sort()).toEqual(["thread.archived", "thread.deleted"]);
  });

  it("launches nothing at all just by being loaded", async () => {
    const host = fakeBb();
    await plugin(host.bb);
    // A plugin that spawns a browser on load would hold a Chromium open on
    // a machine nobody is using it from, forever.
    expect(binary.calls()).toEqual([]);
  });

  // The wiring half of the browser-identity fix. Pre-fix, both of these
  // called `engine.*` directly, which closes the browser but leaves the
  // recorded address behind — and a recorded address whose browser has gone
  // points at a freed ephemeral port that another process may now hold.
  describe("shutting the browser down also forgets where it was", () => {
    it("on dispose", async () => {
      const host = fakeBb();
      await plugin(host.bb);
      await host.kv.set("origin:main", { origin: "http://127.0.0.1:9222", browserId: "abc" });

      await host.dispose();

      expect(host.kv.store.has("origin:main")).toBe(false);
    });

    it("when the headed setting changes", async () => {
      const host = fakeBb();
      await plugin(host.bb);
      await host.kv.set("origin:main", { origin: "http://127.0.0.1:9222", browserId: "abc" });

      host.changeSettings({ headed: true });

      await until(() => !host.kv.store.has("origin:main"), "the remembered address to be dropped");
      // And the browser really was told to close — profile-scoped, in this
      // plugin's own namespace, never `--all`.
      const closes = binary.calls().filter((call) => call.endsWith(" close"));
      expect(closes).toHaveLength(1);
      expect(closes[0]).toContain("--namespace bb-plugin-browser");
      expect(closes[0]).toContain("--session main-control");
      expect(closes[0]).not.toContain("--all");
    });
  });

  describe("the headed setting", () => {
    it("does nothing when some other setting changes", async () => {
      const host = fakeBb();
      await plugin(host.bb);
      await host.kv.set("origin:main", { origin: "http://127.0.0.1:9222", browserId: "abc" });

      host.changeSettings({ idleMinutes: "5" });

      // Read synchronously, deliberately: the handler logs before its first
      // await, so "did it decide to act?" is answerable with no sleep and no
      // race. A sleep here is what let an earlier version of this test
      // survive deleting the guard — the shutdown it should have caught had
      // simply not finished spawning yet. An unconditional shutdown would
      // close the browser under every thread whenever anyone edited an
      // unrelated field.
      expect(host.logs.filter((line) => line.includes("headed is now"))).toEqual([]);

      // And a real headed change afterwards must produce exactly ONE
      // shutdown — proof the first change did not merely run late.
      host.changeSettings({ headed: true });
      await until(() => !host.kv.store.has("origin:main"), "the real change to take effect");
      expect(host.logs.filter((line) => line.includes("headed is now"))).toHaveLength(1);
      expect(binary.calls().filter((call) => call.endsWith(" close"))).toHaveLength(1);
    });

    it("reports a failed relaunch instead of leaving an unhandled rejection", async () => {
      const host = fakeBb();
      await plugin(host.bb);
      // A kv that throws is the shape of a storage failure mid-shutdown.
      // `onChange` is fire-and-forget by contract, so anything escaping it
      // is an unhandled rejection in the plugin host.
      host.kv.delete = async () => {
        throw new Error("kv is gone");
      };

      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => unhandled.push(error);
      process.on("unhandledRejection", onUnhandled);
      try {
        host.changeSettings({ headed: true });
        await until(
          () => host.logs.some((line) => line.startsWith("warn") && line.includes("kv is gone")),
          "the failure to be logged",
        );
        expect(unhandled).toEqual([]);
      } finally {
        process.removeListener("unhandledRejection", onUnhandled);
      }
    });
  });

  describe("a thread going away", () => {
    it("drops the binding of a thread that owned its session", async () => {
      const host = fakeBb();
      await plugin(host.bb);
      // No origin: a cold-start teardown must not launch a browser to find
      // out whether the page is still there (pages that predate the origin
      // field are treated as gone).
      await host.kv.set("page:thr_a", { profile: "main", targetId: "t1" });

      for (const handler of host.events.get("thread.archived") ?? []) {
        await handler({ thread: { id: "thr_a" } });
      }

      expect(host.kv.store.has("page:thr_a")).toBe(false);
      expect(binary.calls()).toEqual([]);
    });

    it("never rejects for a thread that never opened a browser", async () => {
      const host = fakeBb();
      await plugin(host.bb);
      for (const handler of host.events.get("thread.deleted") ?? []) {
        await expect(handler({ thread: { id: "thr_unknown" } })).resolves.toBeUndefined();
      }
    });
  });

  it("stops its sweep service when the host aborts it", async () => {
    const host = fakeBb();
    await plugin(host.bb);
    const controller = new AbortController();
    const running = host.services.get("reaper")!(controller.signal);
    controller.abort();
    await expect(running).resolves.toBeUndefined();
    expect(binary.calls()).toEqual([]);
  });
});
