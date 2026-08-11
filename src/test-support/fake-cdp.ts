import { WebSocketServer, type WebSocket } from "ws";

export interface FakeCdp {
  url: string;
  /** Every {method, params} the client sent. */
  received: { method: string; params: unknown }[];
  /** Targets reported by Target.getTargets. */
  targets: { targetId: string; type: string; url: string }[];
  /** Push an event to every connected client. */
  emit(method: string, params: unknown): void;
  close(): Promise<void>;
}

export async function fakeCdp(): Promise<FakeCdp> {
  const server = new WebSocketServer({ port: 0 });
  const clients = new Set<WebSocket>();
  const state: FakeCdp = {
    url: "",
    received: [],
    targets: [],
    emit(method, params) {
      for (const client of clients) client.send(JSON.stringify({ method, params }));
    },
    async close() {
      for (const client of clients) client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
      let result: unknown = {};
      if (message.method === "Target.getTargets") {
        result = { targetInfos: state.targets };
      }
      if (message.method === "Target.createTarget") {
        created += 1;
        const targetId = `page-${created}`;
        state.targets.push({ targetId, type: "page", url: "about:blank" });
        result = { targetId };
      }
      if (message.method === "Target.closeTarget") {
        const closing = (message.params as { targetId: string }).targetId;
        state.targets = state.targets.filter((t) => t.targetId !== closing);
        result = { success: true };
      }
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });

  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  state.url = `ws://127.0.0.1:${port}/devtools/browser/fake`;
  return state;
}
