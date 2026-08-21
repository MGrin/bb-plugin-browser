// bb-plugin-browser — one real browser, shared by every agent.
//
// Wiring only; the decisions live under src/. The shape:
//
//   A Chromium-family browser (real app, dedicated profile, its own window)
//     └── Playwright over CDP
//           └── one tab per thread, named by CDP targetId
//                 └── the eight tools and `bb browser`
//
// Two rules this file exists to keep, both learned from v1:
//
//   * The browser OUTLIVES the plugin. Nothing here shuts it down on dispose.
//     v1 did, which destroyed every thread's page on every reload and set off
//     a loop that replaced a page every thirty seconds.
//   * The connection is remade on demand. A reload reattaches to the running
//     browser and every thread finds its own tab again, because a targetId is
//     the browser's, not this process's.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Browser } from "playwright-core";
import { chromium } from "./src/playwright-runtime.js";
import { createActions } from "./src/actions.js";
import { detect } from "./src/browsers.js";
import { currentMode, quit as quitBrowser, startOrAttach, type BrowserMode } from "./src/launch.js";
import { profileDirIn } from "./src/profile.js";
import { createModeSwitch } from "./src/mode.js";
import { registerCli } from "./src/cli.js";
import { createReaper2, DEFAULT_IDLE_MINUTES, idleMsFrom } from "./src/reaper2.js";
import { createPageHolder } from "./src/holder.js";
import { createSessionKeyResolver } from "./src/session-key.js";
import { createTabs } from "./src/tabs.js";
import { registerTools, TOOL_NAMES } from "./src/tools.js";

/** How often idle tabs are swept. */
const SWEEP_INTERVAL_MS = 60_000;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    idleMinutes: {
      // A string because bb's descriptors have no number type; `idleMsFrom`
      // parses it and falls back to the default for anything unusable.
      type: "string",
      label: "Close idle tabs after (minutes)",
      description:
        "A tab no thread has used for this long is closed. Only tabs this plugin opened are ever closed — a tab you open yourself is left alone however long it sits there.",
      default: String(DEFAULT_IDLE_MINUTES),
    },
    browserPath: {
      type: "string",
      label: "Browser binary",
      description:
        "Path to the Chromium-family browser to drive — Brave, Chrome, Chromium, Edge, Vivaldi or Opera. Leave empty to use whichever is installed. Firefox and Safari cannot be used: they do not speak the DevTools Protocol. Takes effect the next time the browser starts (`bb browser quit` to apply now).",
      default: "",
    },
  });

  /** The agents' profile. Never the human's — see docs/design-v2.md. */
  const profileDir = async () => profileDirIn((await bb.sdk.system.config()).dataDir);

  /** The configured binary, or undefined to let detection choose. */
  const configuredBinary = async () => (await settings.get()).browserPath?.trim() || undefined;

  let browser: Browser | null = null;
  /** One connect at a time; a burst of commands must not open several. */
  let connecting: Promise<Browser> | null = null;

  /**
   * The connected browser, started if it is not running and reattached if the
   * connection has dropped.
   *
   * `isConnected()` is the check that makes a plugin reload survivable: the
   * old socket is gone but Brave is not, so this reconnects rather than
   * relaunching and the tabs — with their target ids — are still there.
   */
  /** Only used when nothing is running; a live browser keeps its own mode. */
  let launchMode: BrowserMode = "headless";

  async function connected(): Promise<Browser> {
    if (browser?.isConnected()) return browser;
    if (connecting) return connecting;
    connecting = (async () => {
      const endpoint = await startOrAttach({
        profileDir: await profileDir(),
        binary: await configuredBinary(),
        mode: launchMode,
        log: (message) => bb.log.info(message),
      });
      const next = await chromium().connectOverCDP(endpoint.httpEndpoint);
      browser = next;
      return next;
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  const tabs = createTabs({
    browser: connected,
    kv: bb.storage.kv,
    log: (message) => bb.log.info(message),
  });

  const reaper = createReaper2({
    idleMs: async () => idleMsFrom((await settings.get()).idleMinutes),
    listTabs: () => tabs.listTabs(),
    closeTarget: (targetId) => tabs.closeTarget(targetId),
    log: (message) => bb.log.info(message),
    warn: (message) => bb.log.warn(message),
  });

  const actions = createActions({ tabs, activity: reaper });

  // Who last drove each page. A spawned thread shares its parent's session key,
  // so siblings contend for one Page and last navigator wins; this is what makes
  // that visible to the loser instead of silent (MX-229).
  const holder = createPageHolder({ kv: bb.storage.kv });

  // Headless by default; headed for the two moments a human is needed. One
  // profile can only be held by one process, so this is a relaunch — see
  // src/mode.ts for what that costs and why it is worth it.
  const mode = createModeSwitch({
    currentMode: async () => currentMode(await profileDir()),
    capture: async () =>
      (await tabs.listTabs())
        .filter((tab) => tab.sessionKey !== null)
        .map((tab) => ({ sessionKey: tab.sessionKey as string, url: tab.url })),
    quit: async () => {
      const closed = await quitBrowser(await profileDir());
      browser = null;
      return closed;
    },
    relaunch: async (next) => {
      launchMode = next;
      // Brave needs a moment to release the profile lock before the next
      // process can take it; without this the relaunch races the shutdown.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await connected();
    },
    restore: async (sessionKey, url) => {
      await actions.open(sessionKey, url);
    },
    log: (message) => bb.log.info(message),
  });

  registerTools(bb, actions, createSessionKeyResolver(bb), mode, holder);
  registerCli(bb, actions, createSessionKeyResolver(bb), {
    // Browser-level, so it goes past Actions rather than through it: Actions
    // is deliberately per-tab and has no way to end the browser.
    quit: async () => {
      const closed = await quitBrowser(await profileDir());
      browser = null;
      return closed;
    },
    listTabs: () => tabs.listTabs(),
    show: () => mode.show(),
    hide: () => mode.hide(),
    current: () => mode.current(),
    // Worth a line of its own in `status`: on a machine with several browsers
    // installed, "which one am I logged into" is the question behind most of
    // the confusing answers this plugin can give.
    describe: async () => {
      const configured = await configuredBinary();
      if (configured) return `${configured} (configured)`;
      const found = detect();
      return found
        ? `${found.name} — ${found.path} (detected)`
        : "no Chromium-family browser found — set the browserPath setting";
    },
  }, holder);
  bb.agents.configure(() => ({ tools: [...TOOL_NAMES], skills: ["browser"] }));

  bb.background.service("reaper", {
    async start(signal) {
      while (!signal.aborted) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, SWEEP_INTERVAL_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve(undefined);
            },
            { once: true },
          );
        });
        if (signal.aborted) return;
        try {
          await reaper.sweep();
        } catch (error) {
          bb.log.warn(`sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  });

  // A thread that is gone should not leave a tab behind. Idempotent, and the
  // same handler for both events because a thread is routinely archived and
  // then deleted.
  const resolveSessionKey = createSessionKeyResolver(bb);
  const teardown = async ({ thread }: { thread: { id: string } }) => {
    try {
      const sessionKey = await resolveSessionKey(thread.id);
      // Only this thread's own tab: a spawned child shares its parent's key,
      // and closing on the child's teardown would take the parent's tab.
      if (sessionKey !== thread.id) return;
      reaper.forget(sessionKey);
      await tabs.closeTab(sessionKey);
    } catch (error) {
      bb.log.warn(
        `could not close the tab for ${thread.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  bb.events.on("thread.archived", teardown);
  bb.events.on("thread.deleted", teardown);

  bb.onDispose(async () => {
    // Disconnect, never close. The browser is a real window that may have a
    // human in it, and its tabs are how every thread finds its page again
    // after this plugin loads once more.
    if (browser?.isConnected()) {
      await browser.close().catch(() => {});
    }
    browser = null;
    bb.log.info("disconnected from the agents' browser; it keeps running");
  });
}
