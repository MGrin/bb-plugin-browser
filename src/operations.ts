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
  headedFor(profile: string): Promise<boolean>;
}

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

export function createOperations(deps: OperationsDeps): Operations {
  async function command(sessionKey: string, argv: string[]): Promise<string> {
    const profile = await deps.profileFor(sessionKey);
    const headed = await deps.headedFor(profile);
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
      headed,
      attach: true,
      argv: ["connect", pageUrl],
    });
    if (bind.code !== 0) {
      throw new Error(`could not bind to this thread's page: ${bind.stderr.trim()}`);
    }

    const result = await deps.engine.run({
      profile,
      session: sessionKey,
      headed,
      attach: true,
      argv,
    });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `browser command failed: ${argv.join(" ")}`);
    }
    return result.stdout.trim();
  }

  return {
    open: (sessionKey, url) => command(sessionKey, ["open", url]),
    read: (sessionKey) => command(sessionKey, ["read"]),
    snapshot: (sessionKey, interactive) =>
      command(sessionKey, interactive ? ["snapshot", "-i"] : ["snapshot"]),
    click: (sessionKey, selector) => command(sessionKey, ["click", selector]),

    async type(sessionKey, selector, text, submit) {
      const filled = await command(sessionKey, ["fill", selector, text]);
      if (!submit) return filled;
      return command(sessionKey, ["press", "Enter"]);
    },

    evaluate: (sessionKey, expression) => command(sessionKey, ["eval", expression]),

    async screenshot(sessionKey) {
      const path = join(
        tmpdir(),
        `bb-browser-${safeName(sessionKey)}-${process.hrtime.bigint()}.png`,
      );
      try {
        await command(sessionKey, ["screenshot", path]);
        return { base64: (await readFile(path)).toString("base64") };
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
