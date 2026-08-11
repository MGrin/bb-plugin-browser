// What a browser can be asked to do, in the plugin's own vocabulary.
//
// Every operation binds this session to its own page first. Binding is
// idempotent and costs one process spawn, and it is the reason two threads
// acting at the same time cannot land on each other's page.
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "./engine.js";
import type { Pages } from "./pages.js";

export interface OperationsDeps {
  engine: Pick<Engine, "run" | "browserCdpUrl" | "shutdown" | "shutdownAll">;
  pages: Pages;
  profileFor(sessionKey: string): Promise<string>;
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

/** Page-controlled output: ask agent-browser to truncate before it reaches us. */
const capped = (argv: string[]) => [...argv, "--max-output", String(MAX_OUTPUT_CHARS)];

export function createOperations(deps: OperationsDeps): Operations {
  async function command(sessionKey: string, argv: string[]): Promise<string> {
    const profile = await deps.profileFor(sessionKey);
    const pageUrl = await deps.pages.pageUrlFor(sessionKey, profile);

    // attach: true on BOTH calls, not just the bind. A thread session that
    // passes --profile asks agent-browser to LAUNCH Chromium against a
    // profile directory the profile's own browser already holds; Chromium
    // aborts ("Failed to create a ProcessSingleton for your profile
    // directory") and the session is dead for every later command.
    // Measured against agent-browser 0.33.2. Launch mode is the control
    // session's job alone — browserCdpUrl and shutdown own it inside the
    // engine, and the engine's ensure-before-attach guarantees the browser
    // this bind needs is already up.
    const bind = await deps.engine.run({
      profile,
      session: sessionKey,
      attach: true,
      argv: ["connect", pageUrl],
    });
    if (bind.code !== 0) {
      throw new Error(`could not bind to this thread's page: ${bind.stderr.trim()}`);
    }

    const result = await deps.engine.run({
      profile,
      session: sessionKey,
      attach: true,
      argv,
    });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `browser command failed: ${argv.join(" ")}`);
    }
    return result.stdout.trim();
  }

  return {
    // async, so a refused scheme arrives as a rejected promise like every
    // other failure rather than as a synchronous throw the callers of an
    // async interface would not think to catch.
    async open(sessionKey, url) {
      assertOpenableUrl(url);
      return command(sessionKey, ["open", url]);
    },

    // read, snapshot and eval are the three that return page-controlled text.
    read: (sessionKey) => command(sessionKey, capped(["read"])),
    snapshot: (sessionKey, interactive) =>
      command(sessionKey, capped(interactive ? ["snapshot", "-i"] : ["snapshot"])),
    click: (sessionKey, selector) => command(sessionKey, ["click", selector]),

    async type(sessionKey, selector, text, submit) {
      const filled = await command(sessionKey, ["fill", selector, text]);
      if (!submit) return filled;
      return command(sessionKey, ["press", "Enter"]);
    },

    evaluate: (sessionKey, expression) => command(sessionKey, capped(["eval", expression])),

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
      // Closes the page, not the browser: every other thread shares that
      // browser and its cookie jar.
      await deps.pages.closePage(sessionKey);
      return "closed this thread's page";
    },
  };
}
