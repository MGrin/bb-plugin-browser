// Talking to a browser's DevTools endpoint, without ever starting one.
//
// Split out of pages.ts, which now has enough to say about binding a thread
// to a tab that the endpoint plumbing was crowding it out. Nothing in here
// knows what a session or a binding is.
import { openCdp } from "./cdp.js";

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

/** The page-level CDP websocket for one target inside a browser. */
export function pageUrl(browserUrl: string, targetId: string): string {
  const base = new URL(browserUrl);
  return `${base.protocol}//${base.host}/devtools/page/${targetId}`;
}

/**
 * The browser's own identity, out of its CDP websocket URL — the uuid Chrome
 * mints per process and serves at `/devtools/browser/<uuid>`.
 *
 * A host and port identify nothing durable: debugging ports are ephemeral, a
 * closed browser frees one immediately, and the next process to take it may
 * belong to somebody else entirely (this machine runs its own agent-browser
 * Chromiums, in another namespace, on ports from the same pool). So anything
 * that goes back to a remembered address has to check it reached the same
 * browser it remembered, and this is the value to check.
 */
export function browserIdOf(browserUrl: string): string | null {
  const match = /\/devtools\/browser\/([^/?#]+)/.exec(browserUrl);
  return match?.[1] ?? null;
}

/** The plain-HTTP origin backing a CDP websocket URL, for `/json/version`. */
export function httpOriginOf(browserUrl: string): string {
  const base = new URL(browserUrl);
  return `${base.protocol === "wss:" ? "https:" : "http:"}//${base.host}`;
}

// A local process is either already answering or plainly isn't — there is
// no reason to wait anywhere near CDP's normal 30s command timeout to find
// out, and every caller of this is a read-only or best-effort path that must
// resolve quickly rather than stall a stream route or a cleanup on a dead
// port.
const PROBE_TIMEOUT_MS = 750;

/**
 * The browser's current, live CDP websocket URL, discovered by asking its
 * DevTools HTTP endpoint directly — never by calling `engine.browserCdpUrl`,
 * which is launch mode and would start a browser to answer this. `null`
 * covers every failure uniformly (connection refused, timeout, a stale port
 * now held by something else, a malformed response): none of them are a
 * reason to try harder or fall back to launching.
 */
export async function probeBrowserUrl(origin: string): Promise<string | null> {
  try {
    const response = await fetch(`${origin}/json/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    return typeof body.webSocketDebuggerUrl === "string" ? body.webSocketDebuggerUrl : null;
  } catch {
    return null;
  }
}

// Every caller of openCdp wraps its use in try/finally so a throw mid-way (a
// bad send, a JSON parse failure, whatever) still closes the socket.
/** Every open page in a browser. */
export async function listPageTargets(browserUrl: string): Promise<TargetInfo[]> {
  const session = await openCdp(browserUrl);
  try {
    const result = await session.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    return result.targetInfos.filter((target) => target.type === "page");
  } finally {
    session.close();
  }
}

/** Close one page. Errors are the caller's to interpret. */
export async function closeTarget(browserUrl: string, targetId: string): Promise<void> {
  const session = await openCdp(browserUrl);
  try {
    await session.send("Target.closeTarget", { targetId });
  } finally {
    session.close();
  }
}
