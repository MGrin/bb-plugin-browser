// An in-process agent-browser that reproduces the two behaviours that broke
// the plugin's per-thread page binding. Both were measured against the real
// binary (0.33.2) on 2026-08-11 and are written down here so a unit test can
// tell a correct binding apart from one that only looks correct:
//
//  1. `connect` ignores the /devtools/page/<targetId> path it is given. The
//     session lands on some other tab entirely — measured landing on the
//     newest, and on a middle one, but never on the tab named in the path,
//     never on the oldest, and never on the browser's foreground tab. Which
//     one it lands on is a test's choice (`land`), because a fake that
//     always lands on the newest lets "binds to the newest tab" and "binds
//     to the tab it was told" agree by accident — the exact ambiguity that
//     hid this defect for five tasks.
//  2. Labels are unique within a session: a second `tab new --label bbpage`
//     is refused with "Label `bbpage` is already used by another tab", and
//     `tab close bbpage` frees it again — as does closing that tab over CDP,
//     which the session notices (measured). So a session wedges itself only
//     while the labelled tab is still OPEN, which is exactly the state a
//     failed close, a reaper's forget(), or a throw after `tab new` leaves
//     behind. A fake that quietly allows duplicates hides all three.
//  3. A session's current tab is silently replaced whenever ANY new page
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

/** Which tab a `connect` lands the session on, given the browser's tabs. */
export type Landing = (targetIds: string[]) => string | null;

export const landOnNewest: Landing = (ids) => ids.at(-1) ?? null;
export const landOnOldest: Landing = (ids) => ids[0] ?? null;

export interface FakeBrowser {
  run(args: RunArgs): Promise<RunResult>;
  /** Every invocation, in order. */
  calls: RunArgs[];
  /** The tab a session would act on right now, for assertions. */
  currentOf(session: string): string | null;
  /** The labels a session still holds, for assertions about wedging. */
  labelsOf(session: string): string[];
  /** Wipe one session's daemon state, as killing its daemon would. */
  killDaemon(session: string): void;
}

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", code: 0 });
const fail = (stderr: string): RunResult => ({ stdout: "", stderr, code: 1 });

export function fakeBrowser(
  server: FakeCdp,
  options: { land?: Landing } = {},
): FakeBrowser {
  const land = options.land ?? landOnNewest;
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
    // A label lives on its Page, so a tab closed by anyone — including over
    // CDP, behind the session's back — takes its label with it (measured).
    for (const [label, targetId] of state.labels) {
      if (!server.targets.some((target) => target.targetId === targetId)) {
        state.labels.delete(label);
      }
    }
    return state;
  };

  const landed = () => land(server.targets.map((target) => target.targetId));
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
      state.current = landed();
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
        if (label && state.labels.has(label)) {
          // Hazard 2. Nothing is created: a session that reaches here
          // without freeing the label first can never bind again.
          return fail(
            `Label \`${label}\` is already used by another tab; labels must be unique within a session`,
          );
        }
        made += 1;
        const targetId = `tab-${made}`;
        server.targets.push({ targetId, type: "page", url });
        if (label) state.labels.set(label, targetId);
        stealPointers();
        state.current = targetId;
        return ok(url);
      }
      if (rest[0] === "close") {
        const closing = rest[1] ?? "";
        const held = state.labels.get(closing);
        if (!held) {
          return fail(`No tab with label \`${closing}\`; run \`agent-browser tab\` to list open tabs`);
        }
        server.targets = server.targets.filter((t) => t.targetId !== held);
        state.labels.delete(closing);
        if (state.current === held) state.current = landed();
        return ok(`✓ Tab closed`);
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
    // Through stateFor, so a label whose tab has since closed is already
    // gone here — the session notices at its next interaction, as the real
    // one does.
    labelsOf: (session) => [...stateFor(session).labels.keys()],
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
      const errors: string[] = [];
      for (const argv of commands) {
        const result = step(args.session, argv);
        if (result.code !== 0) {
          if (bail) return { stdout: parts.join("\n\n"), stderr: result.stderr, code: 1 };
          // Measured: without --bail the batch runs on, and the invocation
          // still exits non-zero. A caller that reads the exit code alone
          // cannot tell "one optional step failed" from "nothing happened".
          errors.push(result.stderr);
          continue;
        }
        parts.push(result.stdout);
      }
      return errors.length
        ? { stdout: parts.join("\n\n"), stderr: errors.join("\n"), code: 1 }
        : ok(parts.join("\n\n"));
    },
  };
}
