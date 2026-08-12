// Starting — or finding — the one real browser that agents share.
//
// v1 downloaded Chrome for Testing, which announces itself as "only for
// automated testing", never updates, and is not the browser anyone actually
// uses. This launches an INSTALLED Chromium-family browser — whichever one
// `src/browsers.ts` detects, or whichever one the `browserPath` setting names
// — against a profile directory of its own, so it is a normal browser with a
// normal window that happens to accept CDP.
//
// The rule that v1 got wrong, and the reason this module has no `stop()`:
// THE BROWSER OUTLIVES THE PLUGIN. v1 shut its browser down whenever the
// plugin reloaded, which destroyed every open page and every thread's handle
// on one — and a rebind replaces a page rather than finding it, so a plugin
// reload silently threw away whatever a thread was doing, including a
// half-finished login. Here a reload reattaches: the browser keeps running,
// the tabs keep existing, and their target ids stay valid.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBrowser } from "./browsers.js";

/**
 * Chromium writes the port it actually bound here, inside the profile. Asking
 * for port 0 and reading it back is what keeps this from fighting whatever
 * else on the machine wants a fixed debugging port.
 */
const PORT_FILE = "DevToolsActivePort";

/** How long to wait for a freshly launched Brave to publish its port. */
const LAUNCH_TIMEOUT_MS = 20_000;

/**
 * Which mode the running browser was launched in.
 *
 * Written next to the profile because the answer has to survive a plugin
 * reload: the plugin can reattach to a browser it did not start, and asking
 * CDP whether it is headless is not reliable across builds. A file the
 * launcher writes is.
 */
const MODE_FILE = "bb-mode";

export type BrowserMode = "headless" | "headed";

export interface LaunchOptions {
  /** The profile directory this browser owns. Never a human's profile. */
  profileDir: string;
  log: (message: string) => void;
  /**
   * A specific browser binary to use. When unset, the first Chromium-family
   * browser installed on this machine is detected. Comes from the plugin's
   * `browserPath` setting in normal use, and from the test in the live suite.
   */
  binary?: string;
  /**
   * How to launch if nothing is running. Headless is the default because most
   * agent work needs no window; `headed` is for the two moments a human is
   * needed — an auth wall, or "come and look at this".
   *
   * Ignored when a browser is ALREADY running: one profile directory can only
   * be held by one process, so switching modes is a relaunch, and that is a
   * decision for `relaunchAs` rather than a side effect of asking for the
   * endpoint.
   */
  mode?: BrowserMode;
}

export interface BrowserEndpoint {
  /** e.g. "http://127.0.0.1:53211" — what Playwright's connectOverCDP takes. */
  httpEndpoint: string;
  port: number;
  /** True when this call started the browser rather than finding it. */
  launched: boolean;
  /** What the running browser actually is, not what was asked for. */
  mode: BrowserMode;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The port a previous launch published, if that browser is still answering.
 *
 * The file survives a crash, so its presence proves nothing on its own — the
 * probe is what distinguishes "already running" from "left behind". Returning
 * null for a stale file is what makes launching idempotent.
 */
export async function runningPort(profileDir: string): Promise<number | null> {
  const file = join(profileDir, PORT_FILE);
  if (!existsSync(file)) return null;
  const port = Number((await readFile(file, "utf8")).split("\n")[0]?.trim());
  if (!Number.isInteger(port) || port <= 0) return null;
  return (await answersOn(port)) ? port : null;
}

/** Whether a DevTools endpoint on this port is alive right now. */
async function answersOn(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The browser agents share: found if it is already running, started if not.
 *
 * Launch flags, each for a reason:
 *   --remote-debugging-port=0   let the OS pick; read it back from the profile
 *   --user-data-dir             the dedicated profile, never the human's
 *   --no-first-run              no welcome tour on a fresh profile
 *   --no-default-browser-check  never ask to become the default browser
 *   --disable-blink-features=AutomationControlled
 *                               navigator.webdriver stays false. This one is
 *                               not hygiene: an X account was locked in August
 *                               because a browser without it was detected.
 */
export async function startOrAttach(options: LaunchOptions): Promise<BrowserEndpoint> {
  const wanted: BrowserMode = options.mode ?? "headless";
  await mkdir(options.profileDir, { recursive: true });

  const existing = await runningPort(options.profileDir);
  if (existing) {
    const running = await currentMode(options.profileDir);
    options.log(`attached to the agents' browser on port ${existing} (${running})`);
    return {
      httpEndpoint: `http://127.0.0.1:${existing}`,
      port: existing,
      launched: false,
      mode: running,
    };
  }

  // Resolved here rather than at the top of the function ON PURPOSE: attaching
  // to a browser that is already running must not depend on being able to find
  // a binary. Otherwise a machine whose browser moved — an upgrade, a rename —
  // would lose its running session to an error about how to start a new one.
  const { name, path: binary } = resolveBrowser(options.binary);

  // Detached, and stdio ignored: this browser is meant to outlive the plugin
  // load that started it. Keeping a pipe open would tie its lifetime to ours,
  // which is exactly the coupling that made a plugin reload destroy every page.
  const child = spawn(
    binary,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${options.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      // Chromium's modern headless: the same renderer as headed, so a page
      // does not render differently depending on whether anyone is looking.
      ...(wanted === "headless" ? ["--headless=new"] : []),
      // A start page, so a freshly launched browser has something to attach
      // to rather than presenting zero targets.
      //
      // NOT load-bearing, though it looks as if it should be: measured
      // 2026-08-12, a `--headless=new` browser stays alive and answering with
      // every one of its tabs closed, so the reaper clearing the last agent
      // tab does not take the browser with it. Do not add a keep-alive tab on
      // that theory. (Headed on macOS behaves the same way by platform
      // convention — an app outlives its last window — but that was not
      // measured here.)
      //
      // This tab is never bound to a thread and never owned, so the reaper
      // never touches it and it lingers. `bb browser tabs` therefore names it
      // as the browser's own, rather than implying a human opened it.
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const port = await runningPort(options.profileDir);
    if (port) {
      await writeFile(join(options.profileDir, MODE_FILE), wanted, "utf8");
      options.log(`started ${name} for agents on port ${port} (${wanted})`);
      return { httpEndpoint: `http://127.0.0.1:${port}`, port, launched: true, mode: wanted };
    }
    await sleep(200);
  }
  throw new Error(
    `${name} did not publish a debugging port within ${LAUNCH_TIMEOUT_MS}ms — ` +
      `check ${join(options.profileDir, PORT_FILE)}. If ${binary} is not a ` +
      "Chromium-family browser it will never publish one; Firefox and Safari cannot be used.",
  );
}

/**
 * Close the agents' browser.
 *
 * Nothing in the plugin's own lifecycle calls this — the browser deliberately
 * outlives plugin reloads, and closing it is the act that broke v1. It exists
 * so a human can end it on purpose (`bb browser quit`), which is the only time
 * it should happen: it is their window, with possibly their tabs in it.
 *
 * Returns false when there was nothing running to close, so a caller can say
 * "already closed" rather than implying it did something.
 */
export async function quit(profileDir: string): Promise<boolean> {
  const port = await runningPort(profileDir);
  if (!port) return false;
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(2000),
  });
  const { webSocketDebuggerUrl } = (await response.json()) as { webSocketDebuggerUrl: string };
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("could not reach the browser")), {
      once: true,
    });
  });
  socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  socket.close();
  return true;
}

/** What the running (or last-launched) browser is. Headless when unrecorded. */
export async function currentMode(profileDir: string): Promise<BrowserMode> {
  try {
    const raw = (await readFile(join(profileDir, MODE_FILE), "utf8")).trim();
    return raw === "headed" ? "headed" : "headless";
  } catch {
    return "headless";
  }
}
