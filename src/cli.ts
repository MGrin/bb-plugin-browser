// `bb browser …` — the same operations as the tools, for humans and for
// agents that would rather type a command.
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import type { BbPluginApi, PluginCliResult } from "@get-bb/plugin-sdk";
import type { Actions } from "./actions.js";
import type { PageHolder } from "./holder.js";
import { humanizeDuration } from "./mode.js";
import type { SessionKeyResolver } from "./session-key.js";

/**
 * Which commit is this PROCESS running? (MX-139/MX-141)
 *
 * bb bundles a `path:` plugin FROM SOURCE at reload, so a revision read here — at module
 * load, the same moment — is by construction the code now executing. Nothing else can say:
 * `bb plugin list` prints `running` and the source path but no revision, `bb plugin source`
 * has none to record for a path: source, and dist/ is NOT the loaded artifact (its mtime was
 * measured lying by 15 minutes). So a checkout can sit clean on main, every drift check
 * green, while the process runs something older.
 *
 * This file lives in src/, so the repo root is asked for by `--show-toplevel` rather than
 * assumed from the directory — git works from anywhere inside the tree, but the reported
 * sourceDir should be the checkout a human would compare against.
 *
 * Synchronous on purpose: the value must be fixed before anything can observe it, and it is
 * one git call per load. Failure yields rev: null rather than a guess — a tarball install has
 * no git dir, and that must stay distinguishable from a real mismatch so a checker reports
 * UNKNOWN rather than OK. `dirty` rides along because a bundle built from an edited tree
 * matches NO commit, and comparing revisions alone would call that a match.
 */
const BUILD_STAMP: { rev: string | null; dirty: boolean | null; sourceDir: string; loadedAt: string; why: string | null } = (() => {
  const here = import.meta.dirname;
  const loadedAt = new Date().toISOString();
  try {
    const git = (args: string[]): string =>
      execFileSync("git", ["-C", here, ...args], { encoding: "utf8", timeout: 5000 }).trim();
    return {
      rev: git(["rev-parse", "HEAD"]),
      dirty: git(["status", "--porcelain"]).length > 0,
      sourceDir: git(["rev-parse", "--show-toplevel"]),
      loadedAt,
      why: null,
    };
  } catch (e) {
    return { rev: null, dirty: null, sourceDir: here, loadedAt, why: e instanceof Error ? e.message : String(e) };
  }
})();

const ok = (stdout: string): PluginCliResult => ({ exitCode: 0, stdout });
const fail = (stderr: string): PluginCliResult => ({ exitCode: 1, stderr });

/** What the browser sits on with nothing loaded — see `tabLabel`. */
const BLANK_URLS = new Set([
  "about:blank",
  "chrome://newtab/",
  "chrome://new-tab-page/",
  "brave://newtab/",
]);

export interface TabRow {
  url: string;
  sessionKey: string | null;
  ours: boolean;
  /** Which thread drove this tab last — null when nothing has. */
  lastDriver?: string | null;
}

/**
 * Subcommands that drive a page, and therefore contend for it.
 *
 * `tabs`, `status`, `show`, `hide`, `quit` and `build` are about the browser
 * rather than about one page, so they neither claim it nor get a notice — a
 * warning printed by `bb browser tabs` would be noise on the very command an
 * orchestrator runs to investigate the warning.
 */
export const PAGE_COMMANDS = new Set([
  "open",
  "read",
  "snapshot",
  "click",
  "type",
  "eval",
  "screenshot",
  "close",
]);

/**
 * How a tab's last driver is shown, when it is not the thread the tab belongs to.
 *
 * This is the row that identified the culprit on 2026-08-21 — and it did so only
 * because someone happened to look while the offending thread was mid-task. A
 * recorded driver makes that answerable after the fact instead of by luck.
 */
export function driverSuffix(tab: TabRow): string {
  if (!tab.lastDriver || tab.lastDriver === tab.sessionKey) return "";
  return `  <- last driven by ${tab.lastDriver}`;
}

/**
 * How a tab is described in `bb browser tabs`.
 *
 * This is a whole named function because the label it replaced was actively
 * misleading: every unbound tab the plugin had not opened was called "yours",
 * including the blank tab the BROWSER opens at startup. A thread reading its
 * own listing saw an authoritative-sounding "yours" row on about:blank next to
 * its real page, and the reasonable conclusion — "my navigation failed" — was
 * the opposite of the truth.
 *
 * So: never claim whose a tab is when that is not known. The startup tab is
 * named as what it is, an unrecognised tab says only that this plugin did not
 * open it, and the caller's own row is marked so it does not have to be found
 * by matching a thread id by eye.
 */
export function tabLabel(tab: TabRow, callerKey: string): string {
  if (tab.sessionKey) {
    return tab.sessionKey === callerKey ? `${tab.sessionKey} (this thread)` : tab.sessionKey;
  }
  if (tab.ours) return "(agent tab, unbound)";
  if (BLANK_URLS.has(tab.url)) return "(browser startup tab)";
  return "(not opened by bb)";
}

export interface CliBrowser {
  /** Bring the browser on screen for the human. */
  show(): Promise<string>;
  /** Put it back to headless. */
  hide(): Promise<string>;
  /** Which mode it is in right now. */
  current(): Promise<"headless" | "headed">;
  /** How long it has been in that mode, or null when that cannot be known. */
  modeAgeMs(): Promise<number | null>;
  /**
   * What the last automatic return to headless said, if one has happened and
   * nothing has put the browser back on screen since.
   */
  lastAutoHide(): Promise<string | null>;
  /** Which browser is being driven, and where it came from. */
  describe(): Promise<string>;
  /** Close the shared browser. False when there was nothing running. */
  quit(): Promise<boolean>;
  /** Every open tab: ours and the human's alike. */
  listTabs(): Promise<
    {
      targetId: string;
      url: string;
      sessionKey: string | null;
      ours: boolean;
      lastDriver: string | null;
    }[]
  >;
}

export async function runCli(
  operations: Actions,
  sessionKey: string,
  argv: string[],
  browser?: CliBrowser,
): Promise<PluginCliResult> {
  const [subcommand, ...rest] = argv;
  try {
    switch (subcommand) {
      case "open":
        if (!rest[0]) return fail("usage: bb browser open <url>");
        return ok(await operations.open(sessionKey, rest[0]));
      case "read":
        return ok(await operations.read(sessionKey));
      case "snapshot":
        return ok(await operations.snapshot(sessionKey, !rest.includes("--full")));
      case "click":
        if (!rest[0]) return fail("usage: bb browser click <selector>");
        return ok(await operations.click(sessionKey, rest[0]));
      case "type": {
        const submit = rest.includes("--submit");
        const positional = rest.filter((arg) => arg !== "--submit");
        if (positional.length < 2) return fail("usage: bb browser type <selector> <text> [--submit]");
        return ok(await operations.type(sessionKey, positional[0], positional[1], submit));
      }
      case "upload": {
        if (rest.length < 2) return fail("usage: bb browser upload <selector> <absolute-path>...");
        const [selector, ...paths] = rest;
        return ok(await operations.upload(sessionKey, selector, paths));
      }
      case "eval":
        if (!rest[0]) return fail("usage: bb browser eval <expression>");
        return ok(await operations.evaluate(sessionKey, rest[0]));
      case "screenshot": {
        const path = rest[0] ?? "./screenshot.png";
        const shot = await operations.screenshot(sessionKey);
        await writeFile(path, Buffer.from(shot.base64, "base64"));
        return ok(`screenshot saved to ${path}`);
      }
      case "close":
        return ok(await operations.close(sessionKey));
      case "tabs": {
        if (!browser) return fail("tabs is not available here");
        const tabs = await browser.listTabs();
        if (tabs.length === 0) return ok("no tabs open");
        // Whose tab this is matters more than its id: the plugin never closes
        // one that is not its own, and seeing which is which is the point of
        // listing them.
        return ok(
          tabs
            .map((tab) => `${tabLabel(tab, sessionKey).padEnd(28)} ${tab.url}${driverSuffix(tab)}`)
            .join("\n"),
        );
      }
      case "show": {
        if (!browser) return fail("show is not available here");
        return ok(await browser.show());
      }
      case "hide": {
        if (!browser) return fail("hide is not available here");
        return ok(await browser.hide());
      }
      case "status": {
        if (!browser) return fail("status is not available here");
        const [mode, tabs, which, ageMs, autoHidden] = await Promise.all([
          browser.current(),
          browser.listTabs(),
          browser.describe(),
          browser.modeAgeMs(),
          browser.lastAutoHide(),
        ]);
        // Broken out by kind rather than "N open, M ours": the leftover was
        // the browser's own blank startup tab, and a bare remainder made it
        // look like a stray nobody could account for.
        const parts = [
          `${tabs.filter((tab) => tab.ours).length} opened by agents`,
          `${tabs.filter((tab) => !tab.ours && BLANK_URLS.has(tab.url)).length} browser startup`,
          `${tabs.filter((tab) => !tab.ours && !BLANK_URLS.has(tab.url)).length} not ours`,
        ];
        // A clock on HEADED only. That is the state that drifts — 69h and 90h
        // on two occasions (MX-297) — and a duration printed against headless
        // too would turn the line into uptime rather than exposure. A null age
        // prints nothing rather than a guess.
        const age = mode === "headed" && ageMs !== null ? ` for ${humanizeDuration(ageMs)}` : "";
        // The window went away and the human is owed a reason. The plugin log
        // is not where they look; this is.
        const note = autoHidden ? `\n${autoHidden}` : "";
        return ok(`${which}\n${mode}${age}, ${tabs.length} tab(s): ${parts.join(", ")}${note}`);
      }
      case "quit": {
        if (!browser) return fail("quit is not available here");
        const closed = await browser.quit();
        return ok(
          closed
            ? "closed the agents' browser"
            : "the agents' browser was not running",
        );
      }
      default:
        return fail(`unknown subcommand: ${subcommand ?? "(none)"} — run 'bb browser' for the list`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function registerCli(
  bb: BbPluginApi,
  operations: Actions,
  resolveSessionKey: SessionKeyResolver,
  browser: CliBrowser,
  holder: PageHolder,
): void {
  bb.cli.register({
    name: "browser",
    summary: "Drive this thread's browser page",
    commands: [
      { name: "open", summary: "Open a URL", usage: "bb browser open <url>" },
      { name: "read", summary: "Rendered page text", usage: "bb browser read" },
      { name: "snapshot", summary: "Accessibility tree with refs", usage: "bb browser snapshot [--full]" },
      { name: "click", summary: "Click an element", usage: "bb browser click <selector>" },
      { name: "type", summary: "Fill a field", usage: "bb browser type <selector> <text> [--submit]" },
      { name: "eval", summary: "Evaluate JavaScript", usage: "bb browser eval <expression>" },
      { name: "screenshot", summary: "Save a PNG", usage: "bb browser screenshot [path]" },
      { name: "close", summary: "Close this thread's page", usage: "bb browser close" },
      { name: "tabs", summary: "Every open tab and whose it is", usage: "bb browser tabs" },
      { name: "show", summary: "Bring the browser on screen", usage: "bb browser show" },
      { name: "hide", summary: "Put the browser back to headless", usage: "bb browser hide" },
      { name: "status", summary: "Mode and open tabs", usage: "bb browser status" },
      { name: "quit", summary: "Close the shared browser", usage: "bb browser quit" },
      {
        name: "build",
        summary: "Which commit this RUNNING process was loaded from (not the checkout)",
        usage: "bb browser build [--json]",
      },
    ],
    run: async (argv, ctx) => {
      // BEFORE resolveSessionKey, deliberately: that resolves (and can create) this
      // thread's browser session. "What is running" must stay answerable without
      // touching the browser at all, including when the browser is what is broken.
      if (argv[0] === "build") {
        if (argv.includes("--json")) return ok(JSON.stringify(BUILD_STAMP));
        const dirty = BUILD_STAMP.dirty === null ? "" : BUILD_STAMP.dirty ? " +dirty" : "";
        const why = BUILD_STAMP.why ? `  (${BUILD_STAMP.why})` : "";
        return ok(
          `loaded ${BUILD_STAMP.rev ?? "unknown"}${dirty} from ${BUILD_STAMP.sourceDir} at ${BUILD_STAMP.loadedAt}${why}`,
        );
      }
      const sessionKey = await resolveSessionKey(ctx.threadId);
      // Claimed BEFORE the command runs, so the notice describes the state the
      // command is about to execute in. `runCli` is left alone deliberately: it
      // is the shared body the tools and the CLI both lean on, and contention is
      // a property of the CALLER, which only this layer knows.
      const notice = PAGE_COMMANDS.has(argv[0] ?? "")
        ? await holder.claim(sessionKey, ctx.threadId)
        : null;
      const result = await runCli(operations, sessionKey, argv, browser);
      if (!notice) return result;
      // A FAILING page command is where this matters most, not least: "Execution
      // context was destroyed, most likely because of a navigation" is what a
      // sibling's goto looks like from inside your evaluate. Dropping the notice
      // on a non-zero exit would hide the contention in the one result that is
      // already evidence of it.
      if (result.exitCode !== 0) {
        return { exitCode: result.exitCode, stderr: `${notice}\n\n${result.stderr ?? ""}`.trim() };
      }
      return result.stdout ? ok(`${notice}\n\n${result.stdout}`) : ok(notice);
    },
  });
}
