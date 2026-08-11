// An in-process agent-browser that reproduces the two behaviours that broke
// the plugin's per-thread page binding. Both were measured against the real
// binary (0.33.2) on 2026-08-11 and are written down here so a unit test can
// tell a correct binding apart from one that only looks correct:
//
//  1. `connect` ignores the /devtools/page/<targetId> path it is given. The
//     session lands on some other tab entirely — measured landing on the
//     newest, and on a middle one, but never on the tab named in the path,
//     never on the oldest, and never on the browser's foreground tab. This
//     fake lands on the newest, which is the case seen most often and is
//     deterministic; the property under test is only that the path is
//     ignored.
//  2. A session's current tab is silently replaced whenever ANY new page
//     appears in the browser — including a background tab created over CDP
//     by another thread. An explicit `tab <ref>` selection does not survive
//     it. So "select once, then act" is not enough: a thread must re-select
//     its own tab as part of the same invocation that acts.
//
// It shares one browser model with `fakeCdp` — `server.targets` IS the tab
// list — so a test can assert on the pages themselves rather than on what a
// session claims about itself.
import type { RunArgs, RunResult } from "../engine.js";
import type { FakeCdp } from "./fake-cdp.js";

interface SessionState {
  connected: boolean;
  current: string | null;
  labels: Map<string, string>;
}

export interface FakeBrowser {
  run(args: RunArgs): Promise<RunResult>;
  /** Every invocation, in order. */
  calls: RunArgs[];
  /** The tab a session would act on right now, for assertions. */
  currentOf(session: string): string | null;
  /** Wipe one session's daemon state, as killing its daemon would. */
  killDaemon(session: string): void;
}

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", code: 0 });
const fail = (stderr: string): RunResult => ({ stdout: "", stderr, code: 1 });

export function fakeBrowser(server: FakeCdp): FakeBrowser {
  const sessions = new Map<string, SessionState>();
  const calls: RunArgs[] = [];
  let seenTargets = server.targets.length;
  let made = 0;

  const stateFor = (name: string): SessionState => {
    let state = sessions.get(name);
    if (!state) {
      state = { connected: false, current: null, labels: new Map() };
      sessions.set(name, state);
    }
    return state;
  };

  const newest = () => server.targets.at(-1)?.targetId ?? null;

  /** Hazard 2: a new page anywhere steals every session's current tab. */
  function stealPointers(): void {
    if (server.targets.length === seenTargets) return;
    seenTargets = server.targets.length;
    for (const state of sessions.values()) if (state.connected) state.current = newest();
  }

  function step(name: string, argv: string[]): RunResult {
    const state = stateFor(name);
    const [command, ...rest] = argv;

    if (command === "connect") {
      state.connected = true;
      // Hazard 1: whatever page the argument names, the session lands
      // somewhere else. The argument is not even read.
      state.current = newest();
      return ok("✓ Done");
    }

    if (!state.connected) {
      // The real binary would launch a browser of its own here (measured: a
      // fresh Chromium on a throwaway profile). Nothing in this plugin may
      // reach that path, so the fake makes it a loud failure.
      return fail("session is not connected to a browser");
    }

    if (command === "tab") {
      if (rest[0] === "new") {
        const label = rest[1] === "--label" ? rest[2] : undefined;
        const url = (rest[1] === "--label" ? rest[3] : rest[0]) ?? "about:blank";
        made += 1;
        const targetId = `tab-${made}`;
        server.targets.push({ targetId, type: "page", url });
        if (label) state.labels.set(label, targetId);
        stealPointers();
        state.current = targetId;
        return ok(url);
      }
      const ref = rest[0] ?? "";
      const target = state.labels.get(ref);
      if (!target || !server.targets.some((t) => t.targetId === target)) {
        return fail(`No tab with label \`${ref}\`; run \`agent-browser tab\` to list open tabs`);
      }
      state.current = target;
      return ok("✓");
    }

    const target = server.targets.find((t) => t.targetId === state.current);
    if (!target) return fail("no current tab");

    if (command === "open") {
      target.url = rest[0] ?? "about:blank";
      return ok(`✓ ${target.url}`);
    }
    if (command === "get" && rest[0] === "url") return ok(target.url);
    if (command === "read") return ok(`text of ${target.url}`);
    if (command === "eval") {
      // Only the literal form this plugin uses for its readiness marker.
      const expression = rest[0] ?? "";
      return ok(/^".*"$/.test(expression) ? expression : `evaluated on ${target.url}`);
    }
    if (command === "click" || command === "fill" || command === "press") return ok("✓");
    return fail(`unknown command: ${command}`);
  }

  return {
    calls,
    currentOf: (session) => sessions.get(session)?.current ?? null,
    killDaemon(session) {
      sessions.delete(session);
    },
    async run(args) {
      calls.push(args);
      stealPointers();

      if (args.argv[0] !== "batch") return step(args.session, args.argv);

      const commands = JSON.parse(args.stdin ?? "[]") as string[][];
      const bail = args.argv.includes("--bail");
      const parts: string[] = [];
      for (const argv of commands) {
        const result = step(args.session, argv);
        if (result.code !== 0) {
          if (bail) return { stdout: parts.join("\n\n"), stderr: result.stderr, code: 1 };
          parts.push(result.stdout);
          continue;
        }
        parts.push(result.stdout);
      }
      return ok(parts.join("\n\n"));
    },
  };
}
