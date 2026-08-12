// Finding a Chromium to drive.
//
// Nothing here is Brave-specific. Everything this plugin does is CDP —
// `--remote-debugging-port`, `Target.*`, Playwright's connectOverCDP — so any
// Chromium-family browser works: Brave, Chrome, Chromium, Edge, Vivaldi, Opera.
// Brave is simply first in the list because it is the one this was built
// against.
//
// What will NOT work, and why the list is an allowlist rather than a search:
// Firefox and Safari are not Chromium and speak no CDP. Pointing this at
// either produces a browser that starts and then never answers, which is a
// much worse failure than "no browser found".
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface BrowserCandidate {
  /** What to call it in a log line or an error. */
  name: string;
  path: string;
}

/**
 * Candidates in preference order.
 *
 * Order matters only when someone has several installed, and it is a
 * preference rather than a judgement: the first one found is used, and the
 * `browserPath` setting overrides all of it.
 */
export function candidates(): BrowserCandidate[] {
  const home = homedir();
  if (platform() === "darwin") {
    return [
      { name: "Brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
      { name: "Google Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { name: "Chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
      { name: "Microsoft Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
      { name: "Vivaldi", path: "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi" },
      { name: "Opera", path: "/Applications/Opera.app/Contents/MacOS/Opera" },
      // Same apps installed for one user rather than system-wide.
      { name: "Brave (user)", path: join(home, "Applications/Brave Browser.app/Contents/MacOS/Brave Browser") },
      { name: "Google Chrome (user)", path: join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome") },
    ];
  }
  return [
    { name: "Brave", path: "/usr/bin/brave-browser" },
    { name: "Brave", path: "/usr/bin/brave" },
    { name: "Google Chrome", path: "/usr/bin/google-chrome" },
    { name: "Google Chrome", path: "/usr/bin/google-chrome-stable" },
    { name: "Chromium", path: "/usr/bin/chromium" },
    { name: "Chromium", path: "/usr/bin/chromium-browser" },
    { name: "Microsoft Edge", path: "/usr/bin/microsoft-edge" },
    { name: "Vivaldi", path: "/usr/bin/vivaldi" },
    // Flatpak and snap put the real binary somewhere else entirely; these are
    // the wrappers, which accept the same flags.
    { name: "Brave (flatpak)", path: "/var/lib/flatpak/exports/bin/com.brave.Browser" },
    { name: "Chromium (snap)", path: "/snap/bin/chromium" },
  ];
}

/** The first candidate that exists, or null when none do. */
export function detect(): BrowserCandidate | null {
  return candidates().find((candidate) => existsSync(candidate.path)) ?? null;
}

/**
 * Which browser to drive: the configured one if set, else whatever is found.
 *
 * A configured path that does not exist is an error rather than a fallback —
 * silently driving a different browser than the one someone named is how you
 * end up with two profiles and a login in the wrong one.
 */
export function resolveBrowser(configured?: string): BrowserCandidate {
  const wanted = (configured ?? "").trim();
  if (wanted) {
    if (!existsSync(wanted)) {
      throw new Error(
        `the configured browser does not exist: ${wanted} — ` +
          "set the plugin's browserPath to a Chromium-family browser binary, or clear it to auto-detect",
      );
    }
    return { name: "configured browser", path: wanted };
  }

  const found = detect();
  if (found) return found;

  throw new Error(
    "no Chromium-family browser found. This plugin drives any of Brave, Chrome, " +
      "Chromium, Edge, Vivaldi or Opera over CDP — install one, or set the plugin's " +
      "browserPath to its binary. Firefox and Safari cannot be used: they do not speak CDP.",
  );
}
