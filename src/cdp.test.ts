import { afterEach, describe, expect, it } from "vitest";
import { openCdp } from "./cdp.js";
import { fakeCdp, type FakeCdp } from "./test-support/fake-cdp.js";

let server: FakeCdp;
afterEach(async () => { await server?.close(); });

describe("openCdp", () => {
  it("round-trips a command and its result", async () => {
    server = await fakeCdp();
    const session = await openCdp(server.url);
    const result = await session.send<{ targetInfos: unknown[] }>("Target.getTargets");
    expect(result.targetInfos).toEqual([]);
    expect(server.received[0].method).toBe("Target.getTargets");
    session.close();
  });

  it("delivers events to subscribers", async () => {
    server = await fakeCdp();
    const session = await openCdp(server.url);
    const seen: unknown[] = [];
    session.on("Page.screencastFrame", (params) => seen.push(params));
    server.emit("Page.screencastFrame", { data: "AAA", sessionId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual([{ data: "AAA", sessionId: 1 }]);
    session.close();
  });

  it("rejects a CDP-level error instead of resolving it", async () => {
    server = await fakeCdp();
    server.failOn("Target.getTargets", "boom");
    const session = await openCdp(server.url);
    await expect(session.send("Target.getTargets")).rejects.toThrow("boom");
    session.close();
  });

  it("rejects a send made after the caller already closed the socket", async () => {
    server = await fakeCdp();
    const session = await openCdp(server.url);
    session.close();
    await expect(session.send("Target.getTargets")).rejects.toThrow();
  });

  it("rejects a send made after the server closed the socket", async () => {
    server = await fakeCdp();
    const session = await openCdp(server.url);
    await server.close();
    // Give the close event a tick to propagate to the client socket.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(session.send("Target.getTargets")).rejects.toThrow();
  }, 2000);

  it("rejects a still-pending call when the socket closes underneath it", async () => {
    server = await fakeCdp();
    server.silence("Target.getTargets");
    const session = await openCdp(server.url);
    const pending = session.send("Target.getTargets");
    session.close();
    await expect(pending).rejects.toThrow("cdp socket closed");
  });

  it("rejects a call the server never answers, once its timeout elapses", async () => {
    server = await fakeCdp();
    server.silence("Target.getTargets");
    const session = await openCdp(server.url, { timeoutMs: 20 });
    await expect(session.send("Target.getTargets")).rejects.toThrow(/Target\.getTargets/);
  }, 2000);

  it("rejects instead of hanging when the socket accepts the connection and never upgrades", async () => {
    server = await fakeCdp();
    // Exactly the shape the final review measured: TCP accepted, the
    // DevTools HTTP endpoint still answering, and no websocket upgrade ever
    // — which without a connect timeout leaves `openCdp` pending forever
    // (still pending at 3s when it was measured).
    server.holdConnections();
    const started = Date.now();
    await expect(openCdp(server.url, { connectTimeoutMs: 50 })).rejects.toThrow(
      /connect timed out/,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 5_000);

  it("rejects a connect to a port nothing is listening on, rather than waiting out the timeout", async () => {
    server = await fakeCdp();
    const dead = server.url.replace(/:(\d+)\//, (_match, port) => `:${Number(port) + 1}/`);
    await server.close();
    await expect(openCdp(dead, { connectTimeoutMs: 5_000 })).rejects.toThrow(/cdp connect/);
  }, 5_000);

  it("ignores a literal null frame instead of throwing out of the message handler", async () => {
    // `JSON.parse("null")` succeeds, and reading `.id` off the result
    // throws a TypeError inside the WebSocket listener — an uncaught
    // exception in the plugin host, from one frame sent by whatever holds
    // the port.
    server = await fakeCdp();
    const session = await openCdp(server.url);
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.once("uncaughtException", onUncaught);
    try {
      server.sendRaw("null");
      server.sendRaw("42");
      server.sendRaw('"a string"');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(uncaught).toEqual([]);
      const result = await session.send<{ targetInfos: unknown[] }>("Target.getTargets");
      expect(result.targetInfos).toEqual([]);
    } finally {
      process.removeListener("uncaughtException", onUncaught);
      session.close();
    }
  });

  it("ignores a malformed frame instead of throwing out of the message handler", async () => {
    server = await fakeCdp();
    const session = await openCdp(server.url);
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.once("uncaughtException", onUncaught);
    try {
      server.sendRaw("not json{");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(uncaught).toEqual([]);
      // The session must still be usable after the bad frame.
      const result = await session.send<{ targetInfos: unknown[] }>("Target.getTargets");
      expect(result.targetInfos).toEqual([]);
    } finally {
      process.removeListener("uncaughtException", onUncaught);
      session.close();
    }
  });
});
