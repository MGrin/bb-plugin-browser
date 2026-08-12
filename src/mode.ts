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
import type { BrowserMode } from "./brave.js";

export interface ModeDeps {
  currentMode(): Promise<BrowserMode>;
  /** Where each thread's tab currently is, so it can be put back. */
  capture(): Promise<{ sessionKey: string; url: string }[]>;
  quit(): Promise<boolean>;
  /** Start in this mode and reconnect. */
  relaunch(mode: BrowserMode): Promise<void>;
  /** Put a thread back on a url after the relaunch. */
  restore(sessionKey: string, url: string): Promise<void>;
  log(message: string): void;
}

export interface ModeSwitch {
  /** Bring the browser on screen. Returns what actually happened. */
  show(): Promise<string>;
  /** Put it back to headless. */
  hide(): Promise<string>;
  current(): Promise<BrowserMode>;
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

    // Captured BEFORE anything is torn down: after the quit there is nothing
    // left to ask where a thread was.
    const open = (await deps.capture()).filter((entry) => worthRestoring(entry.url));
    deps.log(`switching the browser to ${mode}; ${open.length} tab(s) to restore`);

    await deps.quit();
    await deps.relaunch(mode);

    let restored = 0;
    for (const entry of open) {
      try {
        await deps.restore(entry.sessionKey, entry.url);
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

    const note =
      mode === "headed"
        ? "the browser is now on screen — switch to the Brave window to act"
        : "the browser is headless again";
    return open.length === 0
      ? note
      : `${note} (${restored} of ${open.length} tab(s) restored; anything typed but not submitted is gone)`;
  }

  return {
    show: () => switchTo("headed"),
    hide: () => switchTo("headless"),
    current: () => deps.currentMode(),
  };
}
