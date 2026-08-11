// Every agent-browser invocation this plugin makes.
//
// Two levels live here. A PROFILE is one Chromium and one on-disk directory,
// which is what carries cookies and logins; a Chromium profile directory is
// locked to a single process, so sharing logins means sharing a browser. A
// SESSION is one thread's handle on that browser, bound to its own page in
// Task 4. Nothing else in the plugin spawns a process.
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { agentBrowserNamespace, launchArgs } from "./identity.js";

const run = promisify(execFile);

export interface EngineOptions {
  /**
   * bb's data dir; profiles live under <dataDir>/plugins/browser/profiles.
   * A thunk because bb.sdk (which resolves the real dataDir) is bind-gated:
   * reading it before the server binds throws. Resolved lazily on first use
   * and cached for the engine's lifetime.
   */
  dataDir: () => Promise<string>;
  log: (message: string) => void;
  /** Overridable for tests. */
  binary?: string;
}

export interface RunArgs {
  profile: string;
  session: string;
  argv: string[];
  headed?: boolean;
  /**
   * True for a session that attaches to a profile's already-running
   * browser rather than launching it. `--profile` is omitted: passing it
   * on a connect call makes agent-browser try to launch a second Chromium
   * against a profile directory another process already holds, which
   * aborts on a SingletonLock conflict and kills the session for every
   * later command. `--args` (launch args) is also omitted — it configures
   * how Chromium is launched, and there is no launch to configure when
   * attaching to a browser someone else already started.
   */
  attach?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface Engine {
  run(args: RunArgs): Promise<RunResult>;
  browserCdpUrl(profile: string): Promise<string>;
  shutdown(profile: string): Promise<void>;
  shutdownAll(): Promise<void>;
}

/**
 * The session name the engine uses for its own profile-level commands
 * (cdp-url lookups, shutdown) rather than a thread's page session. Exported
 * so callers can reference or avoid colliding with it.
 */
export function controlSessionFor(profile: string): string {
  return `${profile}-control`;
}

export function createEngine(options: EngineOptions): Engine {
  const binary = options.binary ?? "agent-browser";
  const live = new Set<string>();
  // Profiles this engine instance has confirmed have a browser running,
  // via a launch-mode cdp-url call — the precondition attach mode relies
  // on. Deliberately not derived from `live`: `live` is in-memory process
  // state that resets on a plugin reload or bb restart while the
  // agent-browser daemon and its browser keep running, so treating an
  // empty `live` as "not running" would misfire on the most ordinary case
  // there is. Cleared per-profile on shutdown so a later attach re-ensures.
  const ensured = new Set<string>();
  let dataDir: string | undefined;

  async function resolveDataDir(): Promise<string> {
    if (dataDir === undefined) dataDir = await options.dataDir();
    return dataDir;
  }

  async function profileDir(profile: string): Promise<string> {
    return join(await resolveDataDir(), "plugins", "browser", "profiles", profile);
  }

  async function baseArgs(args: RunArgs): Promise<string[]> {
    const flags = ["--namespace", agentBrowserNamespace, "--session", args.session];
    if (!args.attach) {
      flags.push("--profile", await profileDir(args.profile), "--args", launchArgs);
    }
    if (args.headed) flags.push("--headed");
    return flags;
  }

  async function execRaw(args: RunArgs): Promise<RunResult> {
    const dir = await profileDir(args.profile);
    await mkdir(dir, { recursive: true });
    live.add(args.profile);
    try {
      const { stdout, stderr } = await run(binary, [...(await baseArgs(args)), ...args.argv], {
        maxBuffer: 32 * 1024 * 1024,
      });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? String(error),
        code: typeof failure.code === "number" ? failure.code : 1,
      };
    }
  }

  async function browserCdpUrl(profile: string): Promise<string> {
    const result = await execRaw({
      profile,
      session: controlSessionFor(profile),
      argv: ["get", "cdp-url"],
    });
    const url = result.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
      throw new Error(`no cdp endpoint for profile ${profile}: ${result.stdout || result.stderr}`);
    }
    return url;
  }

  async function exec(args: RunArgs): Promise<RunResult> {
    if (args.attach && !ensured.has(args.profile)) {
      // Runs once per profile per engine lifetime, not once per command:
      // browserCdpUrl is launch mode and idempotent — it starts the
      // browser if none is running yet and just returns the endpoint if
      // one already is. Every later attach call for this profile, within
      // this engine instance, skips straight past this block. If it
      // throws, we let it propagate: an attach that can't guarantee a
      // browser must fail loudly rather than silently launch one without
      // the anti-detection args.
      await browserCdpUrl(args.profile);
      ensured.add(args.profile);
    }
    return execRaw(args);
  }

  return {
    run: exec,
    browserCdpUrl,

    async shutdown(profile) {
      if (!live.has(profile)) return;
      await execRaw({ profile, session: controlSessionFor(profile), argv: ["close"] });
      live.delete(profile);
      ensured.delete(profile);
      options.log(`closed browser for profile ${profile}`);
    },

    async shutdownAll() {
      for (const profile of [...live]) await this.shutdown(profile);
    },
  };
}
