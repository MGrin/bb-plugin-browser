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

export async function openCdp(url: string): Promise<CdpSession> {
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

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
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
    for (const waiter of pending.values()) waiter.reject(new Error("cdp socket closed"));
    pending.clear();
  });

  return {
    send<T>(method: string, params: object = {}) {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
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
