// Connecting to the agents' browser, and healing it when the endpoint is wedged.
//
// MX-1163, measured 2026-09-21 after an overnight laptop sleep: Brave was alive,
// `/json/version` answered, the CDP socket CONNECTED — and Playwright's
// handshake never completed. Every tool call waited out Playwright's 30s default
// and failed, and the plugin kept handing out the same dead endpoint, because
// the HTTP probe `startOrAttach` trusts is exactly the part that stays alive.
// `bb plugin run browser quit` cleared it at once; nothing ran it.
//
// So the connect is bounded, and a timeout against a browser that still answers
// HTTP is a PROVEN wedge: the one case where this plugin closes the browser on
// its own. Everything else keeps the rule launch.ts is built on — the browser
// outlives the plugin:
//
//   * a connect that fails for any other reason is reported, never recovered;
//   * a timeout with the port NOT answering is not proof of anything — an
//     unreadable status is UNKNOWN, and unknown is never a restart;
//   * at most one recovery per wedge. If it fails, the error is reported and
//     no further recovery is attempted until a connect succeeds again, so a
//     browser that will not heal cannot turn every tool call into a relaunch.
import type { Browser } from "playwright-core";
import type { BrowserEndpoint } from "./launch.js";

/** How long a CDP handshake may take before the endpoint is suspected. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** How long `Browser.close` may take to be sent. */
export const QUIT_TIMEOUT_MS = 5_000;
/** How long the old browser may take to stop answering after `Browser.close`. */
export const GONE_TIMEOUT_MS = 10_000;
/**
 * Brave needs a moment to release the profile lock after its port goes quiet;
 * without it the relaunch races the shutdown. Same figure as a mode switch.
 */
export const LOCK_RELEASE_MS = 1_200;

export interface ConnectDeps {
  /** Find the running browser, or start one. */
  attach: () => Promise<BrowserEndpoint>;
  /**
   * Start the replacement after a wedge. Defaults to `attach`; the plugin
   * passes one that relaunches in the mode the wedged browser was in, so a
   * window a human was looking at comes back as a window.
   */
  relaunch?: () => Promise<BrowserEndpoint>;
  /** Playwright's connect; `timeoutMs` is passed through so it gives up too. */
  connectOverCDP: (httpEndpoint: string, timeoutMs: number) => Promise<Browser>;
  /** Whether `/json/version` answers on this port right now. False when unreadable. */
  answers: (port: number) => Promise<boolean>;
  /** `Browser.close` over CDP. False when nothing was running. */
  quit: () => Promise<boolean>;
  log: (message: string) => void;
  warn: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  connectTimeoutMs?: number;
  quitTimeoutMs?: number;
  goneTimeoutMs?: number;
  lockReleaseMs?: number;
}

class Timeout extends Error {}

function bounded<T>(work: Promise<T>, ms: number, what: string, onLate?: (value: T) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Timeout(`${what} did not complete in ${ms}ms`));
    }, ms);
  });
  // A connect that resolves after we gave up would leave a live connection
  // nobody holds; hand it back so it can be closed.
  work.then(
    (value) => {
      if (timedOut) onLate?.(value);
    },
    () => {},
  );
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** The first line only: Playwright appends a multi-line call log, and a receipt is one line. */
const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0]!.trim();

export function createConnector(deps: ConnectDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const connectMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const quitMs = deps.quitTimeoutMs ?? QUIT_TIMEOUT_MS;
  const goneMs = deps.goneTimeoutMs ?? GONE_TIMEOUT_MS;
  const lockMs = deps.lockReleaseMs ?? LOCK_RELEASE_MS;

  /** Set when a recovery failed; cleared by the next connect that succeeds. */
  let recoveryFailed = false;

  const connectTo = (endpoint: BrowserEndpoint) =>
    bounded(
      deps.connectOverCDP(endpoint.httpEndpoint, connectMs),
      // A little longer than the bound Playwright was given, so its own error
      // wins when it fires; ours is the backstop for when it does not.
      connectMs + Math.min(500, connectMs),
      `the CDP handshake with port ${endpoint.port}`,
      (late) => void late.close().catch(() => {}),
    );

  async function waitUntilGone(port: number): Promise<boolean> {
    const deadline = now() + goneMs;
    while (now() < deadline) {
      if (!(await deps.answers(port))) return true;
      await sleep(200);
    }
    return !(await deps.answers(port));
  }

  async function recover(port: number, cause: unknown): Promise<Browser> {
    const started = now();
    const fail = (why: string): never => {
      recoveryFailed = true;
      const text =
        `browser endpoint on port ${port} is wedged (${message(cause)}) and recovery failed ` +
        `after ${now() - started}ms: ${why}. Not retrying; run \`bb plugin run browser quit\`.`;
      deps.warn(text);
      throw new Error(text);
    };

    try {
      await bounded(deps.quit(), quitMs, "Browser.close");
    } catch (error) {
      return fail(`could not close it: ${message(error)}`);
    }
    if (!(await waitUntilGone(port))) {
      return fail(`port ${port} still answered ${goneMs}ms after Browser.close`);
    }
    await sleep(lockMs);

    let endpoint: BrowserEndpoint;
    try {
      endpoint = await (deps.relaunch ?? deps.attach)();
    } catch (error) {
      return fail(`relaunch failed: ${message(error)}`);
    }
    try {
      const browser = await connectTo(endpoint);
      deps.log(
        `recovered a wedged browser endpoint: port ${port} answered /json/version but the ` +
          `CDP handshake did not (${message(cause)}); closed it and reconnected to port ` +
          `${endpoint.port}${endpoint.launched ? " (relaunched)" : ""} in ${now() - started}ms`,
      );
      return browser;
    } catch (error) {
      return fail(`the relaunched browser on port ${endpoint.port} did not connect: ${message(error)}`);
    }
  }

  return async function connect(): Promise<Browser> {
    const endpoint = await deps.attach();
    try {
      const browser = await connectTo(endpoint);
      recoveryFailed = false;
      return browser;
    } catch (error) {
      // Only a timeout can be a wedge. A refused socket or a protocol error is
      // a different failure and restarting would not be the answer to it.
      const timedOut = error instanceof Timeout || (error as Error)?.name === "TimeoutError";
      if (!timedOut || recoveryFailed) throw error;
      // The proof: it still answers HTTP. Not answering — or not knowing — is
      // not proof, and the next call's `attach` relaunches a browser that is
      // really gone without any help from here.
      if (!(await deps.answers(endpoint.port))) throw error;
      return recover(endpoint.port, error);
    }
  };
}
