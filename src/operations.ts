// What a browser can be asked to do, in the plugin's own vocabulary.
//
// Every operation puts this session on its own page first, in the SAME
// invocation that acts. Not as an optimisation — as the only correct order.
// Measured against agent-browser 0.33.2:
//
//   * `connect ws://host/devtools/page/<id>` ignores the page path. The
//     session lands on some other tab; which one varies. So connecting is
//     not binding, and a thread cannot be pointed at its page that way.
//   * A session's selected tab is silently replaced whenever any new page
//     appears in the browser — including a background tab another thread
//     opened over CDP. So selecting once and remembering it is not binding
//     either: the next thread to open a page moves everyone.
//
// What remains is: connect, select this thread's tab, act — as one `batch`,
// so nothing can slip between the select and the act. A readiness marker is
// evaluated between them, which is both how the real command's output is
// found in the batch's combined output and how "the session lost my tab" is
// told apart from "the command failed", without parsing an error message.
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "./engine.js";
import type { Pages } from "./pages.js";

/**
 * What the reaper is told about a session's page being used.
 *
 * It sits here, on the one funnel every command passes through, rather than
 * on the panel or the tool layer: an agent grinding through a long task via
 * the tools is exactly the caller whose page must not be closed under it, and
 * the panel is only one of four ways in (tools, CLI, panel RPC, screencast).
 */
export interface Activity {
  /** This session just used its page: restart its idle clock. */
  touch(sessionKey: string): void;
  /** Hold the page: it is in use until the matching `unwatch`. */
  watch(sessionKey: string): void;
  unwatch(sessionKey: string): void;
  /** There is no page here any more; stop tracking it. */
  forget(sessionKey: string): void;
}

export interface OperationsDeps {
  engine: Pick<Engine, "run" | "browserCdpUrl" | "shutdown" | "shutdownAll">;
  pages: Pages;
  profileFor(sessionKey: string): Promise<string>;
  activity: Activity;
}

/** The only schemes a page may be opened with. */
export const ALLOWED_SCHEMES = ["http:", "https:"] as const;

/**
 * Characters of page-controlled text any one command may return.
 *
 * Page text reaches the model verbatim, and a hostile or merely enormous page
 * would otherwise flow in up to execFile's 32MB buffer and blow a context
 * window. 40k chars is roughly 10k tokens — a few percent of a 200k context,
 * comfortably above the few thousand characters a normal article's rendered
 * text runs to, and far below the ceiling. agent-browser truncates with a
 * visible "[truncated: showing N of M chars]" marker, so the model is told
 * the text was cut rather than silently reading half a page.
 */
export const MAX_OUTPUT_CHARS = 40_000;

/**
 * Bytes of PNG a screenshot may return before it is refused.
 *
 * Base64 inflates by 4/3, so this keeps the encoded payload under ~4.7MB and
 * inside the 5MB per-image limit model APIs impose. An ordinary viewport
 * screenshot is 100-500KB, so only a pathological full-page capture trips it,
 * and a clear error beats a rejected or truncated request downstream.
 */
export const MAX_SCREENSHOT_BYTES = 3_500_000;

export interface Operations {
  open(sessionKey: string, url: string): Promise<string>;
  read(sessionKey: string): Promise<string>;
  snapshot(sessionKey: string, interactive: boolean): Promise<string>;
  click(sessionKey: string, selector: string): Promise<string>;
  type(sessionKey: string, selector: string, text: string, submit: boolean): Promise<string>;
  evaluate(sessionKey: string, expression: string): Promise<string>;
  screenshot(sessionKey: string): Promise<{ base64: string }>;
  close(sessionKey: string): Promise<string>;
}

/** A session key is a thread id, but it reaches a filename here — keep it one. */
const safeName = (sessionKey: string) => sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * The browser must only ever be pointed at the web.
 *
 * file:// would turn `open` + `read` into a local file reader — an
 * exfiltration path for anything the bb server can read, reachable by
 * injection from any page the agent is already looking at. javascript: and
 * data: execute attacker-authored script in whatever origin the tab holds.
 * Enforced here rather than only in the tool schema so the CLI, and anything
 * else that ever calls Operations, inherits the check instead of
 * re-implementing it.
 */
export function assertOpenableUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a valid url: ${url}`);
  }
  if (!(ALLOWED_SCHEMES as readonly string[]).includes(parsed.protocol)) {
    throw new Error(
      `refusing to open ${parsed.protocol} — the browser only opens ${ALLOWED_SCHEMES.join(
        " and ",
      )} urls`,
    );
  }
}

export function createOperations(deps: OperationsDeps): Operations {
  /**
   * One spawn: connect, select this thread's tab, prove it, act. `--bail`
   * means a failure to select stops the batch before the real command runs,
   * so a session that has lost its tab never acts on somebody else's page —
   * and retrying afterwards is safe, because nothing happened.
   */
  async function attempt(
    sessionKey: string,
    binding: { browserWsUrl: string; tab: string },
    argv: string[],
    maxOutput?: number,
  ): Promise<{ bound: boolean; output: string; stderr: string; code: number }> {
    const marker = `bbready-${randomUUID()}`;
    // attach: true, always. A thread session that passes --profile asks
    // agent-browser to LAUNCH Chromium against a profile directory the
    // profile's own browser already holds; Chromium aborts ("Failed to
    // create a ProcessSingleton for your profile directory") and the session
    // is dead for every later command. Launch mode is the control session's
    // job alone — browserCdpUrl and shutdown own it inside the engine, and
    // the engine's ensure-before-attach guarantees the browser this connect
    // needs is already up.
    const result = await deps.engine.run({
      profile: await deps.profileFor(sessionKey),
      session: sessionKey,
      attach: true,
      maxOutput,
      argv: ["batch", "--bail"],
      // JSON on stdin, not batch's argument form: that form splits each
      // command string on whitespace, which would tear a selector or a piece
      // of typed text containing a space into separate arguments.
      stdin: JSON.stringify([
        // Every time, not only on the first command: without it a session
        // whose daemon has been restarted launches a Chromium of its own on
        // a throwaway profile (measured — a stray browser process, logged
        // out, that nothing ever closes). It costs nothing measurable when
        // the session is already connected.
        ["connect", binding.browserWsUrl],
        ["tab", binding.tab],
        ["eval", JSON.stringify(marker)],
        argv,
      ]),
    });

    const at = result.stdout.indexOf(marker);
    if (at === -1) return { bound: false, output: "", stderr: result.stderr, code: result.code };
    return {
      bound: true,
      // Everything the real command printed: the marker is the last thing
      // before it, and it is a fresh uuid, so no page's own text can be
      // mistaken for it.
      output: result.stdout.slice(at + marker.length).replace(/^"/, "").trim(),
      stderr: result.stderr,
      code: result.code,
    };
  }

  async function command(sessionKey: string, argv: string[], maxOutput?: number): Promise<string> {
    // A hold for the duration, not just a timestamp afterwards: a command
    // slower than the idle timeout — a long navigation, a rebind and retry,
    // a fleet's queued work — would otherwise have its page closed half way
    // through by a sweep that saw only when it last FINISHED something.
    deps.activity.watch(sessionKey);
    try {
      return await run(sessionKey, argv, maxOutput);
    } finally {
      // Touch before releasing, so the idle clock starts at the end of the
      // work rather than at its beginning, and so the page is never briefly
      // both unheld and stale.
      deps.activity.touch(sessionKey);
      deps.activity.unwatch(sessionKey);
    }
  }

  async function run(sessionKey: string, argv: string[], maxOutput?: number): Promise<string> {
    const profile = await deps.profileFor(sessionKey);
    let result = await attempt(
      sessionKey,
      await deps.pages.bindingFor(sessionKey, profile),
      argv,
      maxOutput,
    );

    if (!result.bound) {
      // The session could not be put on its tab. The one cause that is
      // recoverable without a human is its daemon having died, taking its
      // labels with it while the browser kept running — so give the thread a
      // fresh, freshly labelled page and try once more. A second failure is
      // reported rather than retried forever.
      result = await attempt(sessionKey, await deps.pages.rebind(sessionKey, profile), argv, maxOutput);
      if (!result.bound) {
        throw new Error(
          `could not put this thread on its own page: ${result.stderr.trim() || "no reason given"}`,
        );
      }
    }

    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `browser command failed: ${argv.join(" ")}`);
    }
    return result.output;
  }

  /** Page-controlled output: ask agent-browser to truncate before it reaches us. */
  const capped = (sessionKey: string, argv: string[]) =>
    command(sessionKey, argv, MAX_OUTPUT_CHARS);

  return {
    // async, so a refused scheme arrives as a rejected promise like every
    // other failure rather than as a synchronous throw the callers of an
    // async interface would not think to catch.
    async open(sessionKey, url) {
      assertOpenableUrl(url);
      return command(sessionKey, ["open", url]);
    },

    // read, snapshot and eval are the three that return page-controlled text.
    read: (sessionKey) => capped(sessionKey, ["read"]),
    snapshot: (sessionKey, interactive) =>
      capped(sessionKey, interactive ? ["snapshot", "-i"] : ["snapshot"]),
    click: (sessionKey, selector) => command(sessionKey, ["click", selector]),

    async type(sessionKey, selector, text, submit) {
      const filled = await command(sessionKey, ["fill", selector, text]);
      if (!submit) return filled;
      return command(sessionKey, ["press", "Enter"]);
    },

    evaluate: (sessionKey, expression) => capped(sessionKey, ["eval", expression]),

    async screenshot(sessionKey) {
      const path = join(
        tmpdir(),
        `bb-browser-${safeName(sessionKey)}-${process.hrtime.bigint()}.png`,
      );
      try {
        await command(sessionKey, ["screenshot", path]);
        const png = await readFile(path);
        if (png.byteLength > MAX_SCREENSHOT_BYTES) {
          throw new Error(
            `screenshot is ${png.byteLength} bytes, over the ${MAX_SCREENSHOT_BYTES}-byte limit — ` +
              "capture a smaller region or read the page as text instead",
          );
        }
        return { base64: png.toString("base64") };
      } finally {
        await rm(path, { force: true });
      }
    },

    async close(sessionKey) {
      // Forgotten first: a session still tracked after its page is gone has
      // the sweep try to close it again, once a minute, forever.
      deps.activity.forget(sessionKey);
      // Closes the page, not the browser: every other thread shares that
      // browser and its cookie jar.
      await deps.pages.closePage(sessionKey);
      return "closed this thread's page";
    },
  };
}
