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
import { createSessionKeyResolver } from "./src/session-key.js";
import { registerTools, TOOL_NAMES } from "./src/tools.js";

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

  registerTools(bb, operations, resolveSessionKey);

  // Registering a tool only makes it exist; `configure` is what puts it in a
  // session's tool set. `skills` stays empty until Task 6 writes
  // skills/browser/SKILL.md — naming a skill this plugin's manifest cannot
  // resolve rejects the whole selection, tools included.
  bb.agents.configure(() => ({ tools: [...TOOL_NAMES], skills: [] }));

  bb.onDispose(async () => {
    await engine.shutdownAll();
  });
}
