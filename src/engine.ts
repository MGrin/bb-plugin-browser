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
  let dataDir: string | undefined;

  async function resolveDataDir(): Promise<string> {
    if (dataDir === undefined) dataDir = await options.dataDir();
    return dataDir;
  }

  async function profileDir(profile: string): Promise<string> {
    return join(await resolveDataDir(), "plugins", "browser", "profiles", profile);
  }

  async function baseArgs(args: RunArgs): Promise<string[]> {
    const flags = [
      "--namespace",
      agentBrowserNamespace,
      "--session",
      args.session,
      "--profile",
      await profileDir(args.profile),
      "--args",
      launchArgs,
    ];
    if (args.headed) flags.push("--headed");
    return flags;
  }

  async function exec(args: RunArgs): Promise<RunResult> {
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

  return {
    run: exec,

    async browserCdpUrl(profile) {
      const result = await exec({
        profile,
        session: controlSessionFor(profile),
        argv: ["get", "cdp-url"],
      });
      const url = result.stdout.trim().split("\n").pop()?.trim() ?? "";
      if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
        throw new Error(`no cdp endpoint for profile ${profile}: ${result.stdout || result.stderr}`);
      }
      return url;
    },

    async shutdown(profile) {
      if (!live.has(profile)) return;
      await exec({ profile, session: controlSessionFor(profile), argv: ["close"] });
      live.delete(profile);
      options.log(`closed browser for profile ${profile}`);
    },

    async shutdownAll() {
      for (const profile of [...live]) await this.shutdown(profile);
    },
  };
}
