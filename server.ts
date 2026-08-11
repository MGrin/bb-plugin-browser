// bb-plugin-browser — a browser inside bb.
//
// This file is only wiring: it builds the engine, the page registry and the
// operations from their pieces and hands the result to the agent tool
// surface. Everything with a decision in it lives under src/.
import type { BbPluginApi } from "@bb/plugin-sdk";
import { createEngine } from "./src/engine.js";
import { defaultProfile } from "./src/identity.js";
import { createOperations } from "./src/operations.js";
import { createPages } from "./src/pages.js";
import { registerPanelRpc } from "./src/panel-rpc.js";
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
        "Some sites render blank headless. Relaunches the browser; logins survive.",
      default: false,
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

  const pages = createPages({
    engine,
    kv: bb.storage.kv,
    log: (message) => bb.log.info(message),
  });

  const resolveSessionKey = createSessionKeyResolver(bb);

  const operations = createOperations({
    engine,
    pages,
    // One profile for now, so every thread shares one cookie jar and one
    // browser. Per-project profiles are a later task's decision.
    profileFor: async () => defaultProfile,
  });

  const screencast = createScreencast({ pages, quality: 60, maxWidth: 1280 });
  // Same single profile as operations above — one cookie jar, one browser,
  // for now.
  registerStreamRoute(bb, screencast, pages, resolveSessionKey, async () => defaultProfile);

  // The panel tab's data plane. Same single profile again, and the same rule
  // as the stream route: it takes a thread id and resolves the session key
  // itself.
  registerPanelRpc(bb, {
    resolveSessionKey,
    operations,
    pages,
    screencast,
    profileFor: async () => defaultProfile,
  });

  registerTools(bb, operations, resolveSessionKey);
  registerCli(bb, operations, resolveSessionKey);

  // Registering a tool only makes it exist; `configure` is what puts it in a
  // session's tool set. A `configure()` return is accepted or rejected as a
  // whole, so naming a skill this plugin's manifest cannot resolve would
  // silently drop the tools too — skills/browser/SKILL.md must resolve for
  // this to have any effect.
  bb.agents.configure(() => ({ tools: [...TOOL_NAMES], skills: ["browser"] }));

  bb.onDispose(async () => {
    screencast.stopAll();
    await engine.shutdownAll();
  });
}
