// bb-plugin-browser — a browser inside bb.
//
// This file is only wiring: it builds the engine, the page registry and the
// operations from their pieces and hands the result to the agent tool
// surface. Everything with a decision in it lives under src/.
import type { BbPluginApi } from "@bb/plugin-sdk";
import { createEngine } from "./src/engine.js";
import { defaultProfile } from "./src/identity.js";
import { createOperations } from "./src/operations.js";
import { createPageRegistry } from "./src/page-registry.js";
import { createPages } from "./src/pages.js";
import { registerPanelRpc } from "./src/panel-rpc.js";
import {
  createReaper,
  createThreadTeardown,
  DEFAULT_IDLE_MINUTES,
  idleMsFrom,
  runSweeps,
  SWEEP_INTERVAL_MS,
} from "./src/reaper.js";
import { createScreencast } from "./src/screencast.js";
import { createSessionKeyResolver } from "./src/session-key.js";
import { registerStreamRoute } from "./src/stream.js";
import { registerTools, TOOL_NAMES } from "./src/tools.js";
import { registerCli } from "./src/cli.js";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    headed: {
      type: "boolean",
      label: "Show the browser window",
      description:
        "Some sites render blank headless. Changing this closes the browser; the next command starts it again in the new mode. The profile directory is untouched, so logins survive.",
      default: false,
    },
    shutdownWhenEmpty: {
      type: "boolean",
      label: "Shut the browser down when it has no pages",
      description:
        "Off by default: shutting the browser down also ends the agent-browser daemon that holds each thread's tab label, which makes the next command replace its page instead of finding it. Reclaiming idle RAM is not worth losing a logged-in page.",
      default: false,
    },
    idleMinutes: {
      // A string, because bb's setting descriptors are string, boolean,
      // select and project — there is no number. `idleMsFrom` parses it and
      // falls back to the default for anything unusable.
      type: "string",
      label: "Close idle pages after (minutes)",
      description:
        "A page no thread has used for this long is closed, so the shared browser does not accumulate tabs forever. A page you have open in the Browser panel is never closed, however idle it looks.",
      default: String(DEFAULT_IDLE_MINUTES),
    },
  });

  const engine = createEngine({
    // A thunk, not a value: bb.sdk is bind-gated and throws before the
    // server is listening, and this factory runs first. The engine resolves
    // it on first use and caches it for its lifetime.
    dataDir: async () => (await bb.sdk.system.config()).dataDir,
    // Read at every launch, so changing the setting and relaunching the
    // browser is enough. The engine applies it only to launch-mode runs —
    // an attach has no window to open.
    headed: async () => (await settings.get()).headed,
    log: (message) => bb.log.info(message),
  });

  // The read-only half, built first and shared. Everything that must never
  // create a page or start a browser — the stream route, the panel's read
  // path, the reaper, the thread teardown — takes THIS, and it has no
  // access to `engine` to do either with. `pages` adds the create/bind
  // half on top for the callers that are allowed to.
  // One broadcast whenever a page appears or goes away, so an open panel can
  // stop believing whatever was true when it mounted. The panel refetches on
  // it rather than polling.
  const announcePageChange = (sessionKey: string) =>
    bb.realtime.publish("page-changed", { sessionKey });

  const registry = createPageRegistry({
    kv: bb.storage.kv,
    log: (message) => bb.log.info(message),
    onPageChanged: announcePageChange,
  });

  const pages = createPages({
    engine,
    kv: bb.storage.kv,
    registry,
    log: (message) => bb.log.info(message),
    onPageChanged: announcePageChange,
  });

  const resolveSessionKey = createSessionKeyResolver(bb);

  // Closing pages nobody is using is not hygiene here: the shared profile
  // restores its tabs when Chromium relaunches, so without a reaper this
  // browser accumulates tabs permanently, across restarts (measured — 21 of
  // them came back after one plugin reload).
  const reaper = createReaper({
    // Read per sweep, so editing the setting takes effect within a minute
    // rather than on the next plugin reload.
    idleMs: async () => idleMsFrom((await settings.get()).idleMinutes),
    // Read per sweep for the same reason, and load-bearing: while the
    // window is up the human is using this browser themselves, and the tabs
    // they open are bound to nobody. See ReaperDeps.headed.
    headed: async () => (await settings.get()).headed,
    // One whole sweep interval of being unowned before a page is closed:
    // pages.ts opens a tab and only then writes its binding, and a sweep
    // landing inside that window must not close a page a thread is about to
    // be handed.
    graceMs: SWEEP_INTERVAL_MS,
    closePage: (sessionKey) => registry.closePage(sessionKey),
    listOpenPages: () => registry.listOpenPages(),
    closeUnboundPage: (targetId) => registry.closeUnboundPage(targetId),
    // Reached only when the browser has no tabs at all. `pages` rather than
    // `registry` because this is the one thing the reaper does that changes
    // the browser's existence rather than its contents — and it is the same
    // call the headed toggle makes, so the remembered address is dropped with
    // the process either way.
    shutdownBrowser: () => pages.shutdownBrowser(defaultProfile),
    shutdownWhenEmpty: async () => (await settings.get()).shutdownWhenEmpty,
    log: (message) => bb.log.info(message),
    // A failed close means a tab is still open that nothing may reference
    // again — that belongs at warn, not info.
    warn: (message) => bb.log.warn(message),
  });

  const operations = createOperations({
    engine,
    pages,
    // One profile for now, so every thread shares one cookie jar and one
    // browser. Per-project profiles are a later task's decision.
    profileFor: async () => defaultProfile,
    // The reaper hears about every command, from the tools, the CLI and the
    // panel alike, because they all funnel through Operations.
    activity: reaper,
  });

  const screencast = createScreencast({ quality: 60, maxWidth: 1280 });
  registerStreamRoute(bb, {
    screencast,
    pages: registry,
    resolveSessionKey,
    // A viewer is a user of the page: watching it must keep it alive.
    viewers: reaper,
  });

  // The panel tab's data plane, on the same read-only registry as the stream
  // route and under the same rule: it takes a thread id and derives the
  // session key itself.
  registerPanelRpc(bb, {
    resolveSessionKey,
    operations,
    pages: registry,
    screencast,
  });

  registerTools(bb, operations, resolveSessionKey);
  registerCli(bb, operations, resolveSessionKey);

  bb.background.service("reaper", {
    start: (signal) => runSweeps(signal, reaper, { warn: (message) => bb.log.warn(message) }),
  });

  // A thread that is gone should not leave a tab behind. The same handler for
  // both events: it is idempotent, and a thread is routinely archived and
  // then deleted.
  const teardown = createThreadTeardown({
    resolveSessionKey,
    closePage: (sessionKey) => registry.closePage(sessionKey),
    forget: (sessionKey) => reaper.forget(sessionKey),
    warn: (message) => bb.log.warn(message),
  });
  bb.events.on("thread.archived", teardown);
  bb.events.on("thread.deleted", teardown);

  // Changing `headed` has to actually do something. The engine reads the
  // setting at every LAUNCH, but a browser that is already running was
  // launched under the old answer and will keep its window (or its absence)
  // forever — so close it here and let the next command start it again. The
  // profile directory is not touched by any of this, which is why logins
  // survive the switch.
  settings.onChange((next, previous) => {
    if (next.headed === previous.headed) return;
    void (async () => {
      try {
        bb.log.info(
          `headed is now ${next.headed}; closing the browser so the next command relaunches it`,
        );
        // The casts point at pages that are about to stop existing.
        screencast.stopAll();
        // Where each thread was, so its next page can go back there rather
        // than coming up blank for a reason that had nothing to do with it.
        await pages.captureForRestore(defaultProfile);
        // Through `pages`, not `engine`: closing the browser and forgetting
        // where it was are one act. A remembered address outlives its
        // browser by pointing at a freed ephemeral port, and the next
        // process to take that port is somebody else's browser.
        await pages.shutdownBrowser(defaultProfile);
      } catch (error) {
        bb.log.warn(
          `could not relaunch the browser after the headed change: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })();
  });

  // Registering a tool only makes it exist; `configure` is what puts it in a
  // session's tool set. A `configure()` return is accepted or rejected as a
  // whole, so naming a skill this plugin's manifest cannot resolve would
  // silently drop the tools too — skills/browser/SKILL.md must resolve for
  // this to have any effect.
  bb.agents.configure(() => ({ tools: [...TOOL_NAMES], skills: ["browser"] }));

  bb.onDispose(async () => {
    screencast.stopAll();
    await pages.shutdownAllBrowsers();
  });
}
