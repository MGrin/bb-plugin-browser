import { describe, expect, it, vi } from "vitest";
import {
  createReaper,
  createThreadTeardown,
  DEFAULT_IDLE_MINUTES,
  idleMsFrom,
  runSweeps,
  type OpenPage,
  type ReaperDeps,
} from "./reaper.js";

function reaperWith(overrides: Partial<ReaperDeps> = {}) {
  const closed: string[] = [];
  const closedTargets: string[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  // The browser's tab list, shared with `closeUnboundPage` the way a real
  // browser shares it: closing a page really removes it from the list.
  const state = { pages: [] as OpenPage[] };
  const reaper = createReaper({
    idleMs: async () => 1000,
    graceMs: 500,
    headed: async () => false,
    closePage: async (sessionKey: string) => {
      closed.push(sessionKey);
    },
    listOpenPages: async () => state.pages,
    closeUnboundPage: async (targetId: string) => {
      closedTargets.push(targetId);
      state.pages = state.pages.filter((page) => page.targetId !== targetId);
    },
    log: (message: string) => logs.push(message),
    warn: (message: string) => warnings.push(message),
    ...overrides,
  });
  return { closed, closedTargets, logs, warnings, state, reaper };
}

/**
 * A page in the browser. `ours` defaults to false — a tab this plugin did
 * NOT open — because that is the conservative default for every test that
 * does not care, and it keeps the headless tests honest: they must still
 * close debris nobody created through this plugin, which is exactly what a
 * relaunch's restored tabs are.
 */
const page = (
  targetId: string,
  sessionKey: string | null = null,
  ours = false,
): OpenPage => ({ targetId, url: "about:blank", sessionKey, ours });

/** A page this plugin opened, whoever is (or is no longer) bound to it. */
const ourPage = (targetId: string, sessionKey: string | null = null): OpenPage =>
  page(targetId, sessionKey, true);

describe("reaper: idle pages", () => {
  it("closes a page idle past the timeout", async () => {
    const { closed, reaper } = reaperWith();
    reaper.touch("thr_a", 0);
    await reaper.sweep(5000);
    expect(closed).toEqual(["thr_a"]);
  });

  it("leaves a recently used page alone", async () => {
    const { closed, reaper } = reaperWith();
    reaper.touch("thr_a", 4500);
    await reaper.sweep(5000);
    expect(closed).toEqual([]);
  });

  // Someone looking at the panel is USING the page, even though no command
  // has run for an hour. Reaping it out from under a live viewer would blank
  // their screen for no reason they could see.
  it("never closes a page someone is watching", async () => {
    const { closed, reaper } = reaperWith();
    reaper.touch("thr_a", 0);
    reaper.watch("thr_a");
    await reaper.sweep(5000);
    expect(closed).toEqual([]);
  });

  it("keeps a page alive while any one of several viewers remains", async () => {
    const { closed, reaper } = reaperWith();
    reaper.touch("thr_a", 0);
    reaper.watch("thr_a");
    reaper.watch("thr_a");
    reaper.unwatch("thr_a");
    await reaper.sweep(5000);
    expect(closed).toEqual([]);
  });

  it("resumes reaping once the last viewer leaves", async () => {
    const { closed, reaper } = reaperWith();
    reaper.touch("thr_a", 0);
    reaper.watch("thr_a");
    reaper.unwatch("thr_a");
    await reaper.sweep(5000);
    expect(closed).toEqual(["thr_a"]);
  });

  it("forgets a session it closed", async () => {
    const { closed, reaper } = reaperWith();
    reaper.touch("thr_a", 0);
    await reaper.sweep(5000);
    await reaper.sweep(9000);
    expect(closed).toEqual(["thr_a"]);
  });

  it("stops tracking a session that was forgotten", async () => {
    const { closed, reaper } = reaperWith();
    reaper.touch("thr_a", 0);
    reaper.forget("thr_a");
    await reaper.sweep(5000);
    expect(closed).toEqual([]);
  });

  // A close that fails leaves the tab OPEN. Dropping the session then would
  // be the worst possible outcome: the tab survives and nothing references
  // it any more. So the session is kept and retried, and the failure is
  // reported rather than swallowed.
  it("keeps a session whose close failed, reports it, and retries next sweep", async () => {
    let attempts = 0;
    const succeeded: string[] = [];
    const { warnings, reaper } = reaperWith({
      closePage: async (sessionKey: string) => {
        attempts += 1;
        if (attempts === 1) throw new Error("cdp exploded");
        succeeded.push(sessionKey);
      },
    });

    reaper.touch("thr_a", 0);
    await reaper.sweep(5000);
    expect(succeeded).toEqual([]);
    expect(warnings.join("\n")).toContain("cdp exploded");

    await reaper.sweep(9000);
    expect(succeeded).toEqual(["thr_a"]);
  });

  // A page bound before this process started has no touch to its name — the
  // plugin was reloaded, or bb restarted, while the browser kept running.
  // Without a starting clock it would never be reaped at all, which is
  // exactly how a shared profile accumulates tabs forever.
  it("starts the idle clock for a bound page it has never seen used", async () => {
    const { closed, state, reaper } = reaperWith();
    state.pages = [page("t1", "thr_old")];

    await reaper.sweep(0);
    expect(closed).toEqual([]);

    await reaper.sweep(2000);
    expect(closed).toEqual(["thr_old"]);
  });

  it("re-reads the idle timeout on every sweep, so changing the setting takes effect", async () => {
    let idleMinutes = 1000;
    const { closed, reaper } = reaperWith({ idleMs: async () => idleMinutes });
    reaper.touch("thr_a", 0);
    await reaper.sweep(500);
    expect(closed).toEqual([]);

    idleMinutes = 100;
    await reaper.sweep(500);
    expect(closed).toEqual(["thr_a"]);
  });
});

// The profile directory restores its tabs when the browser relaunches
// (measured in Task 9b: 21 leftover tabs came back after a plugin reload).
// Chrome mints new target ids on restore, so every restored tab is unbound
// and nothing else will ever close them — the idle pass alone cannot see
// them, because there is no session key left to be idle.
describe("reaper: pages nobody is bound to", () => {
  it("closes a page no binding names, once it is past the grace period", async () => {
    const { closedTargets, state, reaper } = reaperWith();
    state.pages = [page("orphan-1")];

    // First sight only starts its clock: a page created seconds ago may be
    // one whose binding has not been written yet.
    await reaper.sweep(0);
    expect(closedTargets).toEqual([]);

    await reaper.sweep(600);
    expect(closedTargets).toEqual(["orphan-1"]);
  });

  // The grace period is a DURATION, not "one more sweep". Every test around
  // it that only sweeps twice passes just as well against a zero-length
  // grace — so this one sweeps repeatedly inside the window and requires the
  // page to still be there each time. It is the window between `tab new` and
  // the binding being written that this protects, and that window is
  // measured in time, not in sweeps.
  it("waits out the whole grace period, not merely one further sweep", async () => {
    const { closedTargets, state, reaper } = reaperWith();
    state.pages = [page("orphan-1")];

    await reaper.sweep(0);
    for (const now of [100, 200, 300, 400, 499]) {
      await reaper.sweep(now);
      expect(closedTargets).toEqual([]);
    }
    await reaper.sweep(500);
    expect(closedTargets).toEqual(["orphan-1"]);
  });

  // And the clock restarts when a page stops being unowned and then is
  // again: a target that regained a binding has served no part of a fresh
  // grace period, so the time it spent unowned BEFORE must not count.
  it("gives a page that regained and then lost a binding a fresh grace period", async () => {
    const { closedTargets, state, reaper } = reaperWith();
    state.pages = [page("t1")];
    await reaper.sweep(0);

    // Bound — the create-then-bind window closing, most likely.
    state.pages = [page("t1", "thr_a")];
    await reaper.sweep(100);

    // Unowned again: its binding was dropped, or its thread was torn down.
    state.pages = [page("t1")];
    await reaper.sweep(200);
    await reaper.sweep(600);
    // 600 is past the grace period counted from the FIRST sighting, and not
    // past it counted from the second. Only the second is right.
    expect(closedTargets).toEqual([]);

    await reaper.sweep(700);
    expect(closedTargets).toEqual(["t1"]);
  });

  // pages.ts creates a tab and only then writes the binding. A sweep landing
  // inside that window must not close the tab a thread is about to be handed.
  it("never closes a page that gained a binding during the grace period", async () => {
    const { closedTargets, state, reaper } = reaperWith();
    state.pages = [page("t1")];
    await reaper.sweep(0);

    state.pages = [page("t1", "thr_a")];
    await reaper.sweep(600);
    await reaper.sweep(9999);
    expect(closedTargets).toEqual([]);
  });

  it("never closes a page a binding names", async () => {
    const { closedTargets, state, reaper } = reaperWith();
    state.pages = [page("t1", "thr_a")];
    reaper.touch("thr_a", 9999);
    await reaper.sweep(0);
    await reaper.sweep(600);
    expect(closedTargets).toEqual([]);
  });

  // A target id that disappears and later comes back (Chrome reuses nothing,
  // but a fake browser and a restarted one both can) must serve its grace
  // period again rather than being closed the instant it is seen.
  it("restarts the grace period for a target that vanished and came back", async () => {
    const { closedTargets, state, reaper } = reaperWith();
    state.pages = [page("t1")];
    await reaper.sweep(0);

    state.pages = [];
    await reaper.sweep(100);

    state.pages = [page("t1")];
    await reaper.sweep(200);
    expect(closedTargets).toEqual([]);
    await reaper.sweep(800);
    expect(closedTargets).toEqual(["t1"]);
  });

  it("reports a failed close and tries again on the next sweep", async () => {
    let attempts = 0;
    const succeeded: string[] = [];
    const { warnings, state, reaper } = reaperWith({
      closeUnboundPage: async (targetId: string) => {
        attempts += 1;
        if (attempts === 1) throw new Error("close refused");
        succeeded.push(targetId);
      },
    });
    state.pages = [page("orphan-1")];

    await reaper.sweep(0);
    await reaper.sweep(600);
    expect(succeeded).toEqual([]);
    expect(warnings.join("\n")).toContain("close refused");

    await reaper.sweep(1200);
    expect(succeeded).toEqual(["orphan-1"]);
  });

  it("still reaps idle pages when the browser cannot be listed at all", async () => {
    const { closed, warnings, reaper } = reaperWith({
      listOpenPages: async () => {
        throw new Error("no browser");
      },
    });
    reaper.touch("thr_a", 0);
    await reaper.sweep(5000);
    expect(closed).toEqual(["thr_a"]);
    expect(warnings.join("\n")).toContain("no browser");
  });

  // The one that would otherwise close every tab of a browser this plugin
  // does not own: with no reachable browser, `listOpenPages` reports nothing
  // and the sweep must close nothing rather than assume everything is gone.
  it("closes nothing when the browser reports no pages", async () => {
    const { closedTargets, reaper } = reaperWith();
    await reaper.sweep(0);
    await reaper.sweep(60_000);
    expect(closedTargets).toEqual([]);
  });
});

// Headed mode exists so a HUMAN can use this browser — that is the whole
// point of a visible window: logging into the sites the agent then works in.
// A tab they open is bound to nobody, which is exactly what the unbound pass
// closes, so composed with headed mode the reaper closed the human's tab out
// from under them in 60-120 seconds, mid-login.
describe("reaper: the human's own tabs, while the browser is headed", () => {
  it("leaves a tab nobody is bound to alone while the window is up", async () => {
    const { closedTargets, state, reaper } = reaperWith({ headed: async () => true });
    state.pages = [page("the-humans-login-tab")];

    await reaper.sweep(0);
    await reaper.sweep(600);
    expect(closedTargets).toEqual([]);
  });

  // Not merely "for another grace period": open a tab, walk away, come
  // back. Anything time-based only moves the moment it is taken away.
  it("still leaves it alone an hour later", async () => {
    const { closedTargets, state, reaper } = reaperWith({ headed: async () => true });
    state.pages = [page("the-humans-login-tab")];
    for (const now of [0, 600, 60_000, 3_600_000]) await reaper.sweep(now);
    expect(closedTargets).toEqual([]);
  });

  it("still closes a page its own session left idle, because that page is ours", async () => {
    const { closed, state, reaper } = reaperWith({ headed: async () => true });
    state.pages = [page("t1", "thr_a")];
    reaper.touch("thr_a", 0);
    await reaper.sweep(5000);
    expect(closed).toEqual(["thr_a"]);
  });

  // The half the blanket suspension got wrong. A page this plugin opened and
  // then lost the binding for was unreapable until headless returned — and
  // toggling headed relaunches Chromium, which RESTORES that debris with
  // fresh ids. "Headed → lose a binding → toggle twice" carried tabs forward
  // forever. Our own orphans go in both modes; nothing else is touched while
  // the window is up.
  it("still closes an orphan it opened itself while the window is up", async () => {
    const { closedTargets, state, reaper } = reaperWith({ headed: async () => true });
    state.pages = [ourPage("a-page-we-opened-and-lost")];

    await reaper.sweep(0);
    await reaper.sweep(600);
    expect(closedTargets).toEqual(["a-page-we-opened-and-lost"]);
  });

  it("tells its own orphan apart from the human's tab in the same sweep", async () => {
    const { closedTargets, state, reaper } = reaperWith({ headed: async () => true });
    state.pages = [page("the-humans-login-tab"), ourPage("ours")];

    await reaper.sweep(0);
    await reaper.sweep(600);
    expect(closedTargets).toEqual(["ours"]);
  });

  // Headless there is no window and therefore no human tab, and a restored
  // tab carries a fresh target id no record of ours could ever name — so the
  // pass must still close pages it cannot claim. This is the measured case
  // the whole module exists for: 21 leftover tabs came back after one plugin
  // reload, and not one of them was recognisable as ours.
  it("closes a tab it cannot claim once the window is gone", async () => {
    const { closedTargets, state, reaper } = reaperWith({ headed: async () => false });
    state.pages = [page("restored-by-chromium")];

    await reaper.sweep(0);
    await reaper.sweep(600);
    expect(closedTargets).toEqual(["restored-by-chromium"]);
  });

  it("resumes closing unbound tabs once the window is gone", async () => {
    let headed = true;
    const { closedTargets, state, reaper } = reaperWith({ headed: async () => headed });
    state.pages = [page("orphan-1")];
    await reaper.sweep(0);
    await reaper.sweep(600);
    expect(closedTargets).toEqual([]);

    headed = false;
    // A fresh grace period, not a resumed one: the sweeps above were not
    // watching this tab go unowned, they were declining to.
    await reaper.sweep(1200);
    expect(closedTargets).toEqual([]);
    await reaper.sweep(1800);
    expect(closedTargets).toEqual(["orphan-1"]);
  });

  it("says so in the log, once, rather than once a minute", async () => {
    const { logs, state, reaper } = reaperWith({ headed: async () => true });
    state.pages = [page("orphan-1")];
    await reaper.sweep(0);
    await reaper.sweep(600);
    await reaper.sweep(1200);
    expect(logs.filter((line) => line.includes("may be yours"))).toHaveLength(1);
  });
});

describe("idleMsFrom", () => {
  it("reads a plain number of minutes", () => {
    expect(idleMsFrom("45")).toBe(45 * 60_000);
    expect(idleMsFrom("  10 ")).toBe(10 * 60_000);
  });

  // Settings are free text (bb has no number descriptor), so anything can
  // arrive. Every unusable value falls back to the default rather than
  // disabling the reaper — an idleMs of 0 or NaN would either close pages
  // out from under live work or never close any.
  it("falls back to the default for anything unusable", () => {
    for (const raw of [undefined, "", "   ", "soon", "0", "-5", "Infinity"]) {
      expect(idleMsFrom(raw)).toBe(DEFAULT_IDLE_MINUTES * 60_000);
    }
  });
});

describe("runSweeps", () => {
  it("sweeps until the signal aborts, and stops promptly", async () => {
    const controller = new AbortController();
    let sweeps = 0;
    const done = runSweeps(
      controller.signal,
      {
        sweep: async () => {
          sweeps += 1;
          if (sweeps >= 3) controller.abort();
        },
      },
      { intervalMs: 1, warn: () => {} },
    );
    await done;
    expect(sweeps).toBe(3);
  });

  it("keeps sweeping after a sweep throws", async () => {
    const controller = new AbortController();
    const warnings: string[] = [];
    let sweeps = 0;
    await runSweeps(
      controller.signal,
      {
        sweep: async () => {
          sweeps += 1;
          if (sweeps === 1) throw new Error("sweep blew up");
          if (sweeps >= 3) controller.abort();
        },
      },
      { intervalMs: 1, warn: (message) => warnings.push(message) },
    );
    expect(sweeps).toBe(3);
    expect(warnings.join("\n")).toContain("sweep blew up");
  });

  it("never sweeps at all when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const sweep = vi.fn(async () => {});
    await runSweeps(controller.signal, { sweep }, { intervalMs: 1, warn: () => {} });
    expect(sweep).not.toHaveBeenCalled();
  });
});

describe("thread teardown", () => {
  function teardownWith(overrides: Parameters<typeof createThreadTeardown>[0] | object = {}) {
    const closed: string[] = [];
    const forgotten: string[] = [];
    const warnings: string[] = [];
    const teardown = createThreadTeardown({
      resolveSessionKey: async (threadId: string) => threadId,
      closePage: async (sessionKey: string) => {
        closed.push(sessionKey);
      },
      forget: (sessionKey: string) => {
        forgotten.push(sessionKey);
      },
      warn: (message: string) => warnings.push(message),
      ...overrides,
    });
    return { closed, forgotten, warnings, teardown };
  }

  it("closes the page of an archived thread and stops tracking it", async () => {
    const { closed, forgotten, teardown } = teardownWith();
    await teardown({ thread: { id: "thr_a" } });
    expect(closed).toEqual(["thr_a"]);
    expect(forgotten).toEqual(["thr_a"]);
  });

  // A spawned child shares its parent's session key (session-key.ts), so
  // archiving one subagent must never close the coordinator's page out from
  // under a fleet that is still working.
  it("leaves the page alone when the thread only shares someone else's session", async () => {
    const { closed, forgotten, teardown } = teardownWith({
      resolveSessionKey: async () => "thr_parent",
    });
    await teardown({ thread: { id: "thr_child" } });
    expect(closed).toEqual([]);
    expect(forgotten).toEqual([]);
  });

  it("is idempotent — the same thread can be archived and then deleted", async () => {
    const { closed, teardown } = teardownWith();
    await teardown({ thread: { id: "thr_a" } });
    await teardown({ thread: { id: "thr_a" } });
    expect(closed).toEqual(["thr_a", "thr_a"]);
  });

  // bb dispatches these fire-and-forget: a rejected promise here becomes an
  // unhandled rejection in the host, for the very ordinary case of a thread
  // that never had a browser at all.
  it("never throws into bb's dispatcher when closing fails", async () => {
    const { warnings, teardown } = teardownWith({
      closePage: async () => {
        throw new Error("browser is gone");
      },
    });
    await expect(teardown({ thread: { id: "thr_a" } })).resolves.toBeUndefined();
    expect(warnings.join("\n")).toContain("browser is gone");
  });

  it("never throws when the thread itself can no longer be resolved", async () => {
    const { closed, warnings, teardown } = teardownWith({
      resolveSessionKey: async () => {
        throw new Error("thread vanished");
      },
    });
    await expect(teardown({ thread: { id: "thr_a" } })).resolves.toBeUndefined();
    expect(closed).toEqual([]);
    expect(warnings.join("\n")).toContain("thread vanished");
  });
});

// Shutdown ordering, which the sweep loop's own tests did not pin.
//
// A mutation that deleted the post-sleep abort check left the suite green.
// The consequence is one extra full sweep running *during* teardown — the
// plugin is disposing, the browser may already be going away, and the sweep
// closes pages and reaches for a CDP endpoint on the way out.
describe("runSweeps on abort", () => {
  it("does not sweep again when the signal aborts during the sleep", async () => {
    const controller = new AbortController();
    const sweep = vi.fn(async () => {});
    const done = runSweeps(controller.signal, { sweep }, { intervalMs: 50, warn: () => {} });
    // Abort while the loop is parked in its sleep, which is where a plugin
    // reload or a bb shutdown actually lands.
    controller.abort();
    await done;
    expect(sweep).not.toHaveBeenCalled();
  });

  it("stops sweeping once aborted, rather than running one last pass", async () => {
    const controller = new AbortController();
    let calls = 0;
    const sweep = vi.fn(async () => {
      calls += 1;
      if (calls === 1) controller.abort();
    });
    await runSweeps(controller.signal, { sweep }, { intervalMs: 1, warn: () => {} });
    expect(calls).toBe(1);
  });
});
