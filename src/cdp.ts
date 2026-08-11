// A minimal CDP client over Node 22's global WebSocket.
//
// Chrome DevTools Protocol is request/response with numeric ids plus
// unsolicited events. That is all this needs: no dependency, no session
// multiplexing, no reconnect — a dropped socket means the page is gone, and
// the caller creates a new one.
export interface CdpSession {
  send<T = unknown>(method: string, params?: object): Promise<T>;
  on(event: string, handler: (params: unknown) => void): void;
  close(): void;
}

export interface CdpOptions {
  /**
   * How long a single `send` waits for its response before rejecting. A
   * call the browser never answers (a hung tab, a crashed target) must not
   * hang the caller forever. 30s in production; tests override it low so a
   * timeout test doesn't itself take 30s to run.
   */
  timeoutMs?: number;
  /**
   * How long the websocket handshake may take before this rejects.
   *
   * Without it, a socket that accepts TCP and never upgrades leaves the
   * caller pending forever, and forever composes badly: a hang inside
   * `resolveBinding` never settles pages.ts's coalescing entry, which is
   * only deleted in a `finally`, so every later call for that session joins
   * the same dead promise; and the reaper awaits `listOpenPages` on every
   * sweep, so one hang stops it for the plugin's lifetime — silently,
   * because a hang is not a throw and no `catch` ever fires.
   *
   * A rejection has none of those consequences: coalescing maps drop the
   * entry, and the sweep loop logs and carries on.
   */
  connectTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Everything this connects to is a browser on loopback that either answers
 * at once or is not there, so this is a generous outer bound rather than a
 * tuning knob — the point is that it exists at all. (browser-endpoint.ts's
 * HTTP probe of the same browsers uses 750ms.)
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export async function openCdp(url: string, options: CdpOptions = {}): Promise<CdpSession> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    // One AbortController for all three listeners, so whichever outcome
    // arrives first takes the other two off the socket instead of leaving
    // them to fire into an already-settled promise.
    const listeners = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      listeners.abort();
      finish();
    };
    timer = setTimeout(() => {
      settle(() => {
        // Abandon the handshake rather than leaving a half-open socket
        // attached to a process that may never answer.
        try {
          socket.close();
        } catch {
          // A socket that refuses to close is still one nobody holds.
        }
        reject(new Error(`cdp connect timed out after ${connectTimeoutMs}ms: ${url}`));
      });
    }, connectTimeoutMs);
    socket.addEventListener("open", () => settle(resolve), { signal: listeners.signal });
    socket.addEventListener(
      "error",
      () => settle(() => reject(new Error(`cdp connect failed: ${url}`))),
      { signal: listeners.signal },
    );
    // A close before the upgrade completes is a failed connect, not a
    // closed session: without this the caller waits out the whole connect
    // timeout for something already known to be over.
    socket.addEventListener(
      "close",
      () => settle(() => reject(new Error(`cdp connect closed before opening: ${url}`))),
      { signal: listeners.signal },
    );
  });

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const handlers = new Map<string, ((params: unknown) => void)[]>();
  let nextId = 1;
  let closed = false;

  socket.addEventListener("message", (event) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      // A frame that isn't valid JSON is not a protocol violation worth
      // taking the plugin host down for — drop it and keep the session
      // alive for whatever comes next.
      return;
    }
    // Valid JSON is not the same as a CDP message: `JSON.parse("null")`
    // succeeds and yields null, as do "42" and '"hi"', and reading `.id`
    // off any of them throws a TypeError *inside this listener* — which is
    // an uncaught exception in the plugin host, not a failed call. This
    // codebase's own threat model already assumes a foreign process can be
    // holding the port (browser-endpoint.ts's identity check exists for
    // exactly that), so a frame that is not an object is dropped like one
    // that is not JSON.
    if (typeof parsed !== "object" || parsed === null) return;
    const message = parsed as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message: string };
    };
    if (typeof message.id === "number") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    if (!message.method) return;
    for (const handler of handlers.get(message.method) ?? []) handler(message.params);
  });

  socket.addEventListener("close", () => {
    closed = true;
    for (const waiter of pending.values()) waiter.reject(new Error("cdp socket closed"));
    pending.clear();
  });

  return {
    send<T>(method: string, params: object = {}) {
      if (closed || socket.readyState !== WebSocket.OPEN) {
        // The socket already closed (or never opened) and its close
        // handler already ran and drained `pending` — a new entry added
        // now would sit forever with nothing left to reject it, since
        // WebSocket.send() on a non-OPEN socket discards the frame rather
        // than erroring. Fail fast instead of hanging the caller.
        return Promise.reject(new Error(`cdp socket closed: cannot send ${method}`));
      }
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`cdp timeout waiting for ${method} (${timeoutMs}ms)`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v as T);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    close() {
      socket.close();
    },
  };
}
