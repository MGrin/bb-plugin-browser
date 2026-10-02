// browser_goto: reach a page by goal, not by selector (MX-1346).
//
// The work is `mx jev browser run` on the maintainer's machine, which opens the url in
// THIS thread's tab, asks Jev which element moves toward the goal, clicks it, and repeats
// until the goal reads as reached or a budget runs out. This module only launches it and
// renders its `--json` report. It adds no rule and blocks nothing: `browser_click` is
// untouched, and an agent that does not call this tool is not affected by it.
//
// WHY A TOOL AND NOT A HINT. A per-call hint pointing at `mx jev browser run` was removed on
// 2026-09-26: advice moved no agent to use it (0 Jev runs against 32 clicks and 147 opens).
// A tool sits in the list agents already read, and costs nothing until it is called.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** What one launch of `mx` came back with. `code` is null when it was killed. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (
  argv: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<RunResult>;

/**
 * Past `mx jev browser run`'s own wall clock (300 s) plus the 20 s grace it keeps for its
 * last call, so the run always ends itself and reports before this kills it.
 */
export const GOTO_TIMEOUT_MS = 340_000;

/**
 * `mx` by absolute path: bb's server does not inherit a login shell's PATH, so a bare `mx`
 * is not found from here. `MX_BIN` overrides it.
 */
export function mxBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.MX_BIN || join(homedir(), ".local", "bin", "mx");
}

export const runMx: Runner = (argv, env, timeoutMs) =>
  new Promise((resolve) => {
    const [bin, ...args] = argv;
    execFile(
      bin,
      args,
      { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error == null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code)
              : null;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || "") });
      },
    );
  });

interface Report {
  rc: number;
  status: string;
  /** `kept` when the run left its tab open (`--keep-tab`), `closed` when it closed it. */
  tab?: string;
  evidence: unknown;
  history?: string[];
  attribution?: {
    attempted?: number;
    confirmed?: number;
    typed?: { attempted?: number; confirmed?: number };
  };
}

/** The last stdout line that parses as a report object, or null. */
function lastReport(stdout: string): Report | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as Report;
      if (value && typeof value === "object" && typeof value.status === "string") return value;
    } catch {
      // not the report line
    }
  }
  return null;
}

/** Reads the url the caller's tab is on now. It may throw: the tab can be gone. */
export type UrlProbe = () => Promise<string>;

/**
 * Run one goal on this thread's tab and describe what happened.
 *
 * THE TAB STAYS OPEN (MX-1346). The run is asked to keep it, and the report ends with the
 * url the tab is on, read from the tab itself after the run rather than from the run's last
 * snapshot. The first version closed it: the one agent that reached its goal re-opened the
 * same url five seconds later and went to the target by hand, so a done run saved nothing.
 *
 * `threadId` goes to `mx` as BB_THREAD_ID, which is how the `bb plugin run browser` calls it
 * makes land on the CALLER's tab and no other thread's. Every outcome, including a failure
 * to launch, comes back as text rather than a throw: the agent needs to read what the run
 * saw either way.
 */
export async function goto(
  run: Runner,
  threadId: string | undefined,
  goal: string,
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  currentUrl?: UrlProbe,
): Promise<string> {
  const argv = [
    mxBin(env), "jev", "browser", "run", "--goal", goal, "--url", url, "--keep-tab", "--json",
  ];
  const childEnv: NodeJS.ProcessEnv = { ...env };
  if (threadId) childEnv.BB_THREAD_ID = threadId;
  const result = await run(argv, childEnv, GOTO_TIMEOUT_MS);
  const report = lastReport(result.stdout);
  if (!report) {
    const why = result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
    return (
      `status: blind — mx jev browser run returned no report (exit ${result.code ?? "killed"}). ` +
      `${why || "No error text."} Nothing is known about the page; the tab may still be open.`
    );
  }
  const lines = [`status: ${report.status} (rc ${report.rc})`];
  // A blind run puts its reason on stderr only; without it the agent reads "blind" and
  // nothing it can act on (the first real call, MX-1346, came back exactly so).
  if (report.status === "blind") {
    const why = result.stderr.trim().split("\n").pop()?.slice(0, 400);
    if (why) lines.push(`why: ${why}`);
  }
  if (report.evidence != null) lines.push(`evidence: ${JSON.stringify(report.evidence)}`);
  if (report.history?.length) {
    lines.push("steps:");
    for (const step of report.history) lines.push(`  ${step}`);
  }
  const attempted = report.attribution?.attempted ?? 0;
  const confirmed = report.attribution?.confirmed ?? 0;
  const typed = report.attribution?.typed;
  const typedNote =
    typed?.attempted ? `; typed into ${typed.attempted} field(s), ${typed.confirmed ?? 0} confirmed` : "";
  lines.push(
    `clicks: ${attempted} attempted, ${confirmed} confirmed${typedNote}, under the shared signed-in browser profile.`,
  );
  lines.push(await tabLine(report, currentUrl));
  return lines.join("\n");
}

/**
 * What became of the tab, in words the agent can act on. `kept` is the run's own word; a
 * report without it (a failure before the loop, or an `mx` older than `--keep-tab`) closed
 * the tab, and saying "open" there would send the next read to a page that is not there.
 */
async function tabLine(report: Report, currentUrl?: UrlProbe): Promise<string> {
  if (report.tab !== "kept") return "The run closed its tab when it ended.";
  const use =
    "browser_read, browser_snapshot, browser_click and browser_type act on it as it is: " +
    "do not browser_open it again.";
  if (!currentUrl) return `tab: this thread's tab is still open on the page the run ended on. ${use}`;
  try {
    return `final url: ${await currentUrl()}\ntab: this thread's tab is still open on that page. ${use}`;
  } catch (error) {
    const why = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    return `tab: the run left this thread's tab open, but its url could not be read (${why}). browser_read will say what it is on.`;
  }
}
