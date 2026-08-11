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
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function openCdp(url: string, options: CdpOptions = {}): Promise<CdpSession> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`cdp connect failed: ${url}`)),
      { once: true },
    );
  });

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const handlers = new Map<string, ((params: unknown) => void)[]>();
  let nextId = 1;
  let closed = false;

  socket.addEventListener("message", (event) => {
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message: string };
    };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      // A frame that isn't valid JSON is not a protocol violation worth
      // taking the plugin host down for — drop it and keep the session
      // alive for whatever comes next.
      return;
    }
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
