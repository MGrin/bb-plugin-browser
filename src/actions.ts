// What a thread can ask its tab to do.
//
// Every one of these is a Playwright call against that thread's own Page, so
// concurrency is not this module's problem: two threads acting at the same
// time are two Pages, and nothing here holds shared state. That is the whole
// difference from v1, where every command had to re-select a tab first and a
// lost selection silently replaced the page.
//
// The safety rules are unchanged from v1 and deliberately live HERE rather
// than in the tool schemas, so the CLI and anything else that ever calls this
// inherit them instead of re-implementing them:
//   * http/https only — file:// would make open+read a local file reader
//   * page-controlled output is capped before it can reach a model context
import type { Page } from "playwright-core";
import type { Tabs } from "./tabs.js";

/** The only schemes a page may be opened with. */
export const ALLOWED_SCHEMES = ["http:", "https:"] as const;

/**
 * Characters of page-controlled text any one command may return.
 *
 * Page text reaches the model verbatim, so a hostile or merely enormous page
 * would otherwise blow a context window. 40k chars is roughly 10k tokens:
 * comfortably more than a normal article's rendered text, far below the
 * ceiling. Truncation is announced in the returned text, so a model is told
 * the page was cut rather than silently reading half of it.
 */
export const MAX_OUTPUT_CHARS = 40_000;

/**
 * Bytes of PNG a screenshot may return before it is refused.
 *
 * Base64 inflates by 4/3, keeping the encoded payload inside the ~5MB
 * per-image limit model APIs impose. An ordinary viewport capture is
 * 100-500KB, so only a pathological one trips this, and a clear error beats a
 * rejected request downstream.
 */
export const MAX_SCREENSHOT_BYTES = 3_500_000;

/** How long any single page action may take before it gives up. */
const ACTION_TIMEOUT_MS = 20_000;

export interface Actions {
  open(sessionKey: string, url: string): Promise<string>;
  read(sessionKey: string): Promise<string>;
  snapshot(sessionKey: string, interactive: boolean): Promise<string>;
  click(sessionKey: string, selector: string): Promise<string>;
  type(sessionKey: string, selector: string, text: string, submit: boolean): Promise<string>;
  evaluate(sessionKey: string, expression: string): Promise<string>;
  screenshot(sessionKey: string): Promise<{ base64: string }>;
  close(sessionKey: string): Promise<string>;
}

export interface ActionsDeps {
  tabs: Pick<Tabs, "tabFor" | "closeTab">;
  /** Told about every command, so the reaper knows the tab is in use. */
  activity: {
    touch(sessionKey: string): void;
    watch(sessionKey: string): void;
    unwatch(sessionKey: string): void;
    forget(sessionKey: string): void;
  };
}

/**
 * The browser must only ever be pointed at the web.
 *
 * `file://` would turn open+read into a reader for anything the bb server can
 * read — reachable by injection from any page an agent is already looking at.
 * `javascript:` and `data:` execute attacker-authored script in whatever
 * origin the tab holds.
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

/** Cap page-controlled text, and say so rather than truncating silently. */
export function capped(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated: showing ${MAX_OUTPUT_CHARS} of ${text.length} chars]`;
}

export function createActions(deps: ActionsDeps): Actions {
  /**
   * Run something against this thread's page, holding it for the duration.
   *
   * The hold is what stops the idle reaper closing a tab in the middle of a
   * long command — `touch` alone is a timestamp, and a command that outlives
   * the idle timeout would have been reaped while still running.
   */
  async function onPage<T>(sessionKey: string, work: (page: Page) => Promise<T>): Promise<T> {
    deps.activity.watch(sessionKey);
    try {
      const { page } = await deps.tabs.tabFor(sessionKey);
      page.setDefaultTimeout(ACTION_TIMEOUT_MS);
      return await work(page);
    } finally {
      deps.activity.touch(sessionKey);
      deps.activity.unwatch(sessionKey);
    }
  }

  return {
    async open(sessionKey, url) {
      // Before the tab is even fetched: a refused scheme must not be the
      // reason a browser starts or a tab appears.
      assertOpenableUrl(url);
      return onPage(sessionKey, async (page) => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        // The title is the page's own text, so it is capped like any other
        // page-controlled output.
        return capped(`${await page.title()}\n${page.url()}`);
      });
    },

    async read(sessionKey) {
      return onPage(sessionKey, async (page) => capped(await page.locator("body").innerText()));
    },

    async snapshot(sessionKey, interactive) {
      return onPage(sessionKey, async (page) => {
        // Playwright's aria snapshot: roles, names and urls in a structure a
        // model can act on, which is what `page.accessibility` used to give
        // before it was removed. `interactive` trims it to what can be
        // clicked or typed into, which is the common case and far cheaper.
        const snapshot = await page.locator("body").ariaSnapshot();
        if (!interactive) return capped(snapshot);
        const lines = snapshot
          .split("\n")
          .filter((line) => /\b(button|link|textbox|checkbox|radio|combobox|menuitem|tab|switch|slider|searchbox)\b/.test(line));
        return capped(lines.length > 0 ? lines.join("\n") : snapshot);
      });
    },

    async click(sessionKey, selector) {
      return onPage(sessionKey, async (page) => {
        await page.locator(selector).first().click();
        return `clicked ${selector}`;
      });
    },

    async type(sessionKey, selector, text, submit) {
      return onPage(sessionKey, async (page) => {
        const field = page.locator(selector).first();
        await field.fill(text);
        if (submit) await field.press("Enter");
        return submit ? `typed into ${selector} and pressed Enter` : `typed into ${selector}`;
      });
    },

    async evaluate(sessionKey, expression) {
      return onPage(sessionKey, async (page) => {
        const result = await page.evaluate(expression);
        return capped(typeof result === "string" ? result : JSON.stringify(result) ?? "undefined");
      });
    },

    async screenshot(sessionKey) {
      return onPage(sessionKey, async (page) => {
        const png = await page.screenshot({ type: "png" });
        if (png.byteLength > MAX_SCREENSHOT_BYTES) {
          throw new Error(
            `screenshot is ${png.byteLength} bytes, over the ${MAX_SCREENSHOT_BYTES}-byte limit — ` +
              "capture a smaller region or read the page as text instead",
          );
        }
        return { base64: png.toString("base64") };
      });
    },

    async close(sessionKey) {
      // Forgotten first: a session still tracked after its tab is gone has the
      // reaper trying to close it again, once a minute, forever.
      deps.activity.forget(sessionKey);
      await deps.tabs.closeTab(sessionKey);
      return "closed this thread's tab";
    },
  };
}
