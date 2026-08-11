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
import { agentBrowserNamespace, launchArgs } from "./identity.js";

/**
 * execFile, but with stdin. `promisify(execFile)` hands back only the
 * output, and `batch` takes its command list on stdin — so the callback form
 * is used here purely to get at the ChildProcess and write to it. stdin is
 * always closed, including when there is nothing to send: a `batch` left
 * waiting for EOF would hang forever, and no other command reads it.
 */
function runBinary(binary: string, argv: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      binary,
      argv,
      { maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number }) | null;
        if (!failure) return resolve({ stdout, stderr, code: 0 });
        resolve({
          stdout,
          stderr: stderr || String(error),
          code: typeof failure.code === "number" ? failure.code : 1,
        });
      },
    );
    child.stdin?.end(stdin ?? "");
  });
}

export interface EngineOptions {
  /**
   * bb's data dir; profiles live under <dataDir>/plugins/browser/profiles.
   * A thunk because bb.sdk (which resolves the real dataDir) is bind-gated:
   * reading it before the server binds throws. Resolved lazily on first use
   * and cached for the engine's lifetime.
   */
  dataDir: () => Promise<string>;
  /**
   * Whether a browser this engine launches should show a window. A thunk,
   * resolved at every launch rather than captured once, so changing the
   * setting and relaunching the browser is enough to make it take effect.
   *
   * It lives here rather than on RunArgs because --headed configures a
   * LAUNCH, and attach-mode runs launch nothing: passing it there was a knob
   * that silently did nothing, which is exactly how the setting came to be
   * inert. The only launch path is browserCdpUrl's control session, so this
   * is the only place the answer is ever needed. Defaults to headless.
   */
  headed?: () => Promise<boolean>;
  log: (message: string) => void;
  /** Overridable for tests. */
  binary?: string;
}

export interface RunArgs {
  profile: string;
  session: string;
  argv: string[];
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
  /**
   * Text piped to the process's stdin. `batch` reads its command list as
   * JSON from stdin, which is the only form that survives arguments
   * containing spaces and quotes — its argument form splits each command
   * string on whitespace, so a selector or a piece of typed text with a
   * space in it would be torn into separate arguments.
   */
  stdin?: string;
  /**
   * agent-browser's `--max-output`, which truncates page-controlled text.
   * It is a GLOBAL flag: inside `batch`, a step that carries it is rejected
   * with "Unknown subcommand: --max-output" (measured), so the cap has to be
   * declared once for the whole invocation, before the subcommand.
   */
  maxOutput?: number;
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
    if (args.maxOutput !== undefined) flags.push("--max-output", String(args.maxOutput));
    if (!args.attach) {
      flags.push("--profile", await profileDir(args.profile), "--args", launchArgs);
      // Launch mode only: --headed describes a browser being started, and an
      // attach has no launch to describe.
      if (await options.headed?.()) flags.push("--headed");
    }
    return flags;
  }

  async function execRaw(args: RunArgs): Promise<RunResult> {
    const dir = await profileDir(args.profile);
    await mkdir(dir, { recursive: true });
    live.add(args.profile);
    return runBinary(binary, [...(await baseArgs(args)), ...args.argv], args.stdin);
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
