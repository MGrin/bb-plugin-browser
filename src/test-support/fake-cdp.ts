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
  /** Push an event to every connected client. */
  emit(method: string, params: unknown): void;
  /** Push a raw, possibly-malformed frame to every connected client. */
  sendRaw(data: string): void;
  /** Never answer a call for this method — proves request timeouts. */
  silence(method: string): void;
  /** Answer a call for this method with a CDP protocol error instead of a result. */
  failOn(method: string, message: string): void;
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
  const server = new WebSocketServer({ server: httpServer });
  const clients = new Set<WebSocket>();
  const silenced = new Set<string>();
  const failing = new Map<string, string>();
  const state: FakeCdp = {
    url: "",
    received: [],
    targets: [],
    get connectionCount() {
      return clients.size;
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
      failing.set(method, message);
    },
    async close() {
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

  server.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
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
