// Showing the browser to a human, and putting it away again.
//
// Headless by default: most agent work needs no window, and a window that
// appears unbidden while someone is working is its own kind of bug. Headed for
// exactly two moments — a wall only a human can pass (a login, a CAPTCHA, a
// confirmation), and "come and look at this".
//
// One profile directory can only be held by ONE process, so the same profile
// in both modes means switching is a relaunch rather than a second browser.
// That is a physical constraint of Chromium, not a design choice, and it has
// one visible consequence worth being honest about: in-page state does not
// survive the switch. A half-typed form is lost; the page it was on is not,
// and neither is the login, because the profile directory is untouched.
import type { BrowserMode } from "./launch.js";

/**
 * How long the browser may sit on screen with nobody putting it back.
 *
 * MEASURED, not chosen (MX-297). 759 lines of plugin.log to 2026-08-22 give
 * five headed episodes, and they are bimodal with nothing in between:
 *
 *   69.35h  nobody hid it (ended by a browser restart)
 *      70s  deliberate `hide`
 *     193s  deliberate `hide`
 *     125s  deliberate `hide`
 *   89.68h  still headed when this was written
 *
 * Every real takeover ended in <=193s with somebody calling `hide`; both
 * drifts ran 69-90h with no `hide` at all. 159.04h of the 159.15h the browser
 * spent headed — 99.9% — is those two episodes. So the threshold goes into a
 * 1291x empty band, and six hours sits 112x above the longest takeover anyone
 * has had while still cutting the exposure by 92.5%. Below about four hours
 * the extra saving is tiny (95.0% -> 98.7% between 4h and 1h) and the margin
 * shrinks in proportion, which is a bad trade on a rule that closes a window.
 */
export const DEFAULT_HEADED_HOURS = 6;

/**
 * The threshold as free text — bb has no number descriptor, same as the
 * reaper's. `off`/`never`/`0` disable the return entirely, because a rule that
 * closes somebody's window has to be refusable in the words they would reach
 * for. Anything unusable falls back to the default rather than to 0: silently
 * off is precisely the drift this exists to end.
 */
export function autoHideMsFrom(raw: string | undefined): number {
  const text = (raw ?? "").trim().toLowerCase();
  if (text === "off" || text === "never" || text === "0") return 0;
  const hours = Number(text);
  const usable = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_HEADED_HOURS;
  return usable * 3_600_000;
}

/** A duration as a person would say it — for a log line and for `status`. */
export function humanizeDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

/** One open tab, as the switch needs to see it. */
export interface OpenTab {
  /** The browser's own id for the page — what a binding is written against. */
  targetId: string;
  url: string;
  /** The thread whose binding names it, or null for nobody's. */
  sessionKey: string | null;
  /** Whether this plugin opened it. A human's tab is never ours. */
  ours: boolean;
}

export interface ModeDeps {
  currentMode(): Promise<BrowserMode>;
  /** Whether a browser is answering at all. A mode file outlives its process. */
  running(): Promise<boolean>;
  /** When the running browser was launched into its mode, or null if unknown. */
  modeSince(): Promise<number | null>;
  /** How long headed may last unattended; 0 disables the return entirely. */
  autoHideAfterMs(): Promise<number>;
  /** True while an agent has a page command in flight. */
  busy(): boolean;
  /**
   * Every tab open right now. Read TWICE: before the quit, to know where each
   * thread was and which pages were not ours, and again after the relaunch, to
   * see what the browser restored by itself.
   */
  openTabs(): Promise<OpenTab[]>;
  quit(): Promise<boolean>;
  /** Start in this mode and reconnect. */
  relaunch(mode: BrowserMode): Promise<void>;
  /** Take a page the browser restored as this thread's tab. */
  adopt(sessionKey: string, targetId: string): Promise<void>;
  /** Put a thread back on a url after the relaunch, when nothing was restored. */
  restore(sessionKey: string, url: string): Promise<void>;
  log(message: string): void;
}

export interface ModeSwitch {
  /** Bring the browser on screen. Returns what actually happened. */
  show(): Promise<string>;
  /** Put it back to headless. */
  hide(): Promise<string>;
  current(): Promise<BrowserMode>;
  /** How long the browser has been in its current mode, or null if unknown. */
  modeAgeMs(now?: number): Promise<number | null>;
  /**
   * Put a browser back that has been on screen far too long to have a human in
   * front of it. Returns what it did, or null when it did nothing.
   */
  autoHide(now?: number): Promise<string | null>;
}

/** Pages worth reopening: a blank tab restored is still a blank tab. */
const worthRestoring = (url: string) => /^https?:\/\//.test(url);

export function createModeSwitch(deps: ModeDeps): ModeSwitch {
  async function switchTo(mode: BrowserMode): Promise<string> {
    const running = await deps.currentMode();
    if (running === mode) {
      return mode === "headed"
        ? "the browser is already on screen"
        : "the browser is already headless";
    }

    // Read BEFORE anything is torn down: after the quit there is nothing left
    // to ask where a thread was.
    const before = await deps.openTabs();
    const open = before
      .filter((tab): tab is OpenTab & { sessionKey: string } => tab.sessionKey !== null)
      .filter((tab) => worthRestoring(tab.url));
    // Pages that were NOT ours. Session restore brings these back too, and one
    // of them may sit on the same url as an agent's page.
    const foreign = before.filter((tab) => !tab.ours).map((tab) => tab.url);
    deps.log(`switching the browser to ${mode}; ${open.length} tab(s) to restore`);

    await deps.quit();
    await deps.relaunch(mode);

    // WHAT THE BROWSER ALREADY DID (MX-306). Chromium session-restores the
    // profile's pages on relaunch, so each one is back before this code runs —
    // with a NEW target id, which means no binding names it and no `owned:`
    // record calls it ours. Reopening it left a second copy that was `ours:
    // false` and bound to nobody, and the reaper's first line is `if
    // (!tab.ours) continue` — the rule that protects a human's tab. So nothing
    // ever closed those: one per agent tab per switch, plus a blank per launch,
    // forever. Adopting the restored page instead both ends the duplication and
    // puts the page back under the reaper, which is what should have been
    // tidying it.
    const candidates = (await deps.openTabs()).filter(
      (tab) => !tab.ours && tab.sessionKey === null,
    );
    // A url is all there is to match on, and after a relaunch a human's
    // restored tab looks exactly like ours: unbound and unowned. So before any
    // adoption, one restored page is set aside for each page that was not ours.
    // In the ordinary case — his copy and ours both restored — this changes
    // nothing, because the two are interchangeable. It matters when the browser
    // brought back FEWER copies than there were: without it the last page at
    // that url gets adopted, and it may be his.
    for (const url of foreign) {
      const index = candidates.findIndex((tab) => tab.url === url);
      if (index !== -1) candidates.splice(index, 1);
    }

    let restored = 0;
    let adopted = 0;
    for (const entry of open) {
      try {
        const index = candidates.findIndex((tab) => tab.url === entry.url);
        if (index !== -1) {
          const [page] = candidates.splice(index, 1);
          await deps.adopt(entry.sessionKey, page!.targetId);
          adopted += 1;
        } else {
          await deps.restore(entry.sessionKey, entry.url);
        }
        restored += 1;
      } catch (error) {
        // One page failing to come back is not a reason to abandon the rest,
        // and the thread will open what it needs on its next command anyway.
        deps.log(
          `could not restore ${entry.url} for ${entry.sessionKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (adopted > 0) {
      deps.log(`adopted ${adopted} tab(s) the browser restored by itself`);
    }

    const note =
      mode === "headed"
        ? "the browser is now on screen — switch to the Brave window to act"
        : "the browser is headless again";
    return open.length === 0
      ? note
      : `${note} (${restored} of ${open.length} tab(s) restored; anything typed but not submitted is gone)`;
  }

  async function modeAgeMs(now = Date.now()): Promise<number | null> {
    const since = await deps.modeSince();
    return since === null ? null : Math.max(0, now - since);
  }

  /**
   * THE THING THIS CANNOT KNOW, said out loud because the design turns on it:
   * the plugin has no signal for whether a human is at the window. `show` is an
   * agent asking for one; there is no matching event for the human having
   * answered. `hide` is the only resolution signal there is, and the three real
   * takeovers in the log all sent it inside 193 seconds.
   *
   * So the two conditions that look obvious are both wrong, and measurably:
   *
   *   * "idle N minutes with no agent activity" is ANTI-correlated. Agent
   *     idleness is what `show` CREATES — the agent asks and then stops, waiting
   *     — so that condition is at its most true exactly during a takeover. It
   *     would fire hardest on the case it exists to protect.
   *   * "no tabs that are not ours" is wrong in both directions at once. The
   *     login a human passes happens in the AGENT's tab, so the rule permits
   *     hiding mid-login; and one foreign tab (workspace.withluca.co) was open
   *     across the whole 89h drift, so it would never have fired on the case it
   *     exists for.
   *
   * bb's own `sdk.system.attention()` is not a substitute: it is one machine-wide
   * boolean, and at 2026-08-22T09:55Z it was true for three production alerts
   * with nothing to do with a browser. Gating on it would mean never firing.
   *
   * What is left is duration, which the measurement says separates the two cases
   * cleanly — plus the three guards below, none of which is about the human:
   * an unknown clock, a browser that is not running, and an agent mid-command.
   */
  async function autoHide(now = Date.now()): Promise<string | null> {
    const limit = await deps.autoHideAfterMs();
    if (limit <= 0) return null;
    if ((await deps.currentMode()) !== "headed") return null;

    const age = await modeAgeMs(now);
    // Unknown is a third answer, not "just now" (never fires) and not "forever
    // ago" (fires at once, on a window somebody may be in front of).
    if (age === null || age < limit) return null;

    // A mode file outlives the process that wrote it. Acting on a crashed
    // browser's leftover would START one purely in order to put it away.
    if (!(await deps.running())) return null;

    // A switch is a relaunch, so doing it under a live page command turns
    // another thread's `open` into an error. It has waited hours; it can wait
    // for the next sweep.
    if (deps.busy()) {
      deps.log("would return the browser to headless, but an agent is mid-command; waiting");
      return null;
    }

    // Said in full because a vanished window with no explanation is a bug,
    // and a vanished window that says why and how to undo it is a recoverable
    // inconvenience. That difference is the entire price of a wrong hide.
    const reason =
      `the browser had been on screen for ${humanizeDuration(age)} with nobody hiding it, ` +
      "so it has been put back — `bb browser show` brings it back, and the pages with it " +
      "(set this plugin's `headedHours` to `off` to stop this happening)";
    deps.log(reason);
    return `${reason}. ${await switchTo("headless")}`;
  }

  return {
    show: () => switchTo("headed"),
    hide: () => switchTo("headless"),
    current: () => deps.currentMode(),
    modeAgeMs,
    autoHide,
  };
}
