// `bb browser …` — the same operations as the tools, for humans and for
// agents that would rather type a command.
import { writeFile } from "node:fs/promises";
import type { BbPluginApi, PluginCliResult } from "@bb/plugin-sdk";
import type { Actions } from "./actions.js";
import type { SessionKeyResolver } from "./session-key.js";

const ok = (stdout: string): PluginCliResult => ({ exitCode: 0, stdout });
const fail = (stderr: string): PluginCliResult => ({ exitCode: 1, stderr });

export interface CliBrowser {
  /** Bring the browser on screen for the human. */
  show(): Promise<string>;
  /** Put it back to headless. */
  hide(): Promise<string>;
  /** Which mode it is in right now. */
  current(): Promise<"headless" | "headed">;
  /** Close the shared browser. False when there was nothing running. */
  quit(): Promise<boolean>;
  /** Every open tab: ours and the human's alike. */
  listTabs(): Promise<
    { targetId: string; url: string; sessionKey: string | null; ours: boolean }[]
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
        return ok(
          tabs
            .map((tab) => {
              // Whose tab this is matters more than its id: the plugin never
              // closes one that is not its own, and seeing which is which is
              // the point of listing them.
              const who = tab.sessionKey ? tab.sessionKey : tab.ours ? "(ours, unbound)" : "yours";
              return `${who.padEnd(24)} ${tab.url}`;
            })
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
        const [mode, tabs] = await Promise.all([browser.current(), browser.listTabs()]);
        const ours = tabs.filter((tab) => tab.ours).length;
        return ok(`${mode}, ${tabs.length} tab(s) open (${ours} opened by agents)`);
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
    ],
    run: async (argv, ctx) =>
      runCli(operations, await resolveSessionKey(ctx.threadId), argv, browser),
  });
}
