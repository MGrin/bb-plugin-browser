import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export interface FakeCdp {
  url: string;
  /** Every {method, params} the client sent. */
  received: { method: string; params: unknown }[];
  /** Targets reported by Target.getTargets. */
  targets: { targetId: string; type: string; url: string }[];
  /**
   * Sockets currently connected. Screencast leans on refcounting to close
   * sessions nobody needs — this is how tests prove a close actually
   * happened on the wire, not just that `CdpSession.close()` was called.
   */
  readonly connectionCount: number;
  /**
   * Resolves when exactly `count` sockets are connected — the real signal a
   * test needs, instead of sleeping for a fixed budget and hoping.
   *
   * A websocket teardown is three hops (client close frame, server close
   * frame, socket close event), and a fixed `setTimeout(20)` gives all three
   * a 20ms budget on a machine that owes nothing to anyone: it failed 5 runs
   * in 34 in isolation and 0 in 5 inside the full suite, and that inversion
   * is the proof it was never load. Rejects on timeout, so a fix that
   * genuinely leaks a socket still fails the test rather than hanging it.
   */
  whenConnections(count: number, timeoutMs?: number): Promise<void>;
  /**
   * Queue every websocket upgrade from now on instead of completing it, so
   * a test can pin the exact moment a client's `openCdp` resolves — or make
   * it never resolve at all, which is the hang the connect timeout exists
   * for. Plain HTTP (`/json/version`) is unaffected: a browser whose
   * DevTools HTTP endpoint answers while its websocket never upgrades is
   * precisely the failure being reproduced.
   */
  holdConnections(): void;
  /** Stop queueing NEW upgrades; anything already queued stays queued. */
  allowConnections(): void;
  /** Complete `count` queued upgrades (default: all of them). */
  releaseHeld(count?: number): void;
  /** Push an event to every connected client. */
  emit(method: string, params: unknown): void;
  /** Push a raw, possibly-malformed frame to every connected client. */
  sendRaw(data: string): void;
  /** Never answer a call for this method — proves request timeouts. */
  silence(method: string): void;
  /**
   * Answer a call for this method with a CDP protocol error instead of a
   * result. `null` clears it again, so a test can make one call fail and the
   * next succeed — which is what "recovering from a failed call" needs.
   */
  failOn(method: string, message: string | null): void;
  close(): Promise<void>;
}

export async function fakeCdp(): Promise<FakeCdp> {
  // A real `http.Server`, not the bare internal one `new WebSocketServer({
  // port })` would make for itself: pages.ts's origin probe hits plain HTTP
  // GET /json/version on the same port real Chrome serves it on, alongside
  // the WS upgrade — so a fake that only handles upgrades can no longer
  // stand in for a real browser.
  const httpServer: Server = createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ webSocketDebuggerUrl: state.url }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  // `noServer`, so the upgrade is this fake's own to complete or to hold.
  // With `{ server }` the ws library completes every upgrade the instant it
  // arrives, and there is then no way to stand in for a browser that
  // accepts the TCP connection and never speaks websocket.
  const server = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  const silenced = new Set<string>();
  const failing = new Map<string, string>();
  let holding = false;
  const held: { complete: () => void; abandon: () => void }[] = [];
  const connectionWatchers = new Set<() => void>();

  httpServer.on("upgrade", (request, socket, head) => {
    // A client that gives up on a held handshake (which is what a connect
    // timeout does) drops the raw socket; without a listener that surfaces
    // as an uncaught ECONNRESET.
    socket.on("error", () => {});
    const complete = () => {
      server.handleUpgrade(request, socket, head, (ws) => {
        server.emit("connection", ws, request);
      });
    };
    if (holding) held.push({ complete, abandon: () => socket.destroy() });
    else complete();
  });

  const state: FakeCdp = {
    url: "",
    received: [],
    targets: [],
    get connectionCount() {
      return clients.size;
    },
    whenConnections(count, timeoutMs = 2_000) {
      if (clients.size === count) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          connectionWatchers.delete(check);
          reject(
            new Error(
              `still ${clients.size} connection(s) after ${timeoutMs}ms, expected ${count}`,
            ),
          );
        }, timeoutMs);
        function check() {
          if (clients.size !== count) return;
          clearTimeout(timer);
          connectionWatchers.delete(check);
          resolve();
        }
        connectionWatchers.add(check);
      });
    },
    holdConnections() {
      holding = true;
    },
    allowConnections() {
      holding = false;
    },
    releaseHeld(count = Number.POSITIVE_INFINITY) {
      for (let index = 0; index < count && held.length > 0; index++) held.shift()!.complete();
    },
    emit(method, params) {
      for (const client of clients) client.send(JSON.stringify({ method, params }));
    },
    sendRaw(data) {
      for (const client of clients) client.send(data);
    },
    silence(method) {
      silenced.add(method);
    },
    failOn(method, message) {
      if (message === null) failing.delete(method);
      else failing.set(method, message);
    },
    async close() {
      // Anything still queued would otherwise hold its TCP socket — and the
      // http server's `close` — open past the end of the test.
      holding = false;
      while (held.length > 0) held.shift()!.abandon();
      for (const client of clients) client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // `WebSocketServer` attached to an external server (the `{ server }`
      // option above) never closes that server itself — without this, the
      // HTTP listener (and therefore the port) would leak past the test.
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };

  // A count of targets ever created, not `state.targets.length`: tests
  // simulate a page vanishing behind our back by clearing `state.targets`
  // directly, and a length-derived id would then collide with the id it
  // just freed up instead of proving a *new* target was made.
  let created = 0;

  const notify = () => {
    for (const watcher of [...connectionWatchers]) watcher();
  };

  server.on("connection", (socket) => {
    clients.add(socket);
    notify();
    socket.on("close", () => {
      clients.delete(socket);
      notify();
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as {
        id: number;
        method: string;
        params?: unknown;
      };
      state.received.push({ method: message.method, params: message.params });

      // A method under `silence()` never gets a reply — the caller is left
      // hanging exactly as an unresponsive real browser would.
      if (silenced.has(message.method)) return;

      let result: unknown = {};
      let error: { message: string } | undefined;

      if (failing.has(message.method)) {
        error = { message: failing.get(message.method)! };
      } else if (message.method === "Target.getTargets") {
        result = { targetInfos: state.targets };
      } else if (message.method === "Target.createTarget") {
        created += 1;
        const targetId = `page-${created}`;
        state.targets.push({ targetId, type: "page", url: "about:blank" });
        result = { targetId };
      } else if (message.method === "Target.closeTarget") {
        const closing = (message.params as { targetId: string }).targetId;
        const exists = state.targets.some((t) => t.targetId === closing);
        if (exists) {
          state.targets = state.targets.filter((t) => t.targetId !== closing);
          result = { success: true };
        } else {
          // Real Chrome errors closing a targetId it no longer knows about.
          error = { message: `No target with given id found: ${closing}` };
        }
      }

      socket.send(JSON.stringify(error ? { id: message.id, error } : { id: message.id, result }));
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  state.url = `ws://127.0.0.1:${port}/devtools/browser/fake`;
  return state;
}
