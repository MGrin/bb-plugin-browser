// `bb browser …` — the same operations as the tools, for humans and for
// agents that would rather type a command.
import { writeFile } from "node:fs/promises";
import type { BbPluginApi, PluginCliResult } from "@bb/plugin-sdk";
import type { Operations } from "./operations.js";
import type { SessionKeyResolver } from "./session-key.js";

const ok = (stdout: string): PluginCliResult => ({ exitCode: 0, stdout });
const fail = (stderr: string): PluginCliResult => ({ exitCode: 1, stderr });

export async function runCli(
  operations: Operations,
  sessionKey: string,
  argv: string[],
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
      default:
        return fail(`unknown subcommand: ${subcommand ?? "(none)"} — run 'bb browser' for the list`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function registerCli(
  bb: BbPluginApi,
  operations: Operations,
  resolveSessionKey: SessionKeyResolver,
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
    ],
    run: async (argv, ctx) => runCli(operations, await resolveSessionKey(ctx.threadId), argv),
  });
}
