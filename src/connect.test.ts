import { describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { createConnector, type ConnectDeps } from "./connect.js";

const fakeBrowser = (name: string) => ({ name, close: async () => {} }) as unknown as Browser;
const never = () => new Promise<Browser>(() => {});

/**
 * A fake runtime for the MX-1163 incident: the browser on port 100 answers
 * `/json/version` but its CDP handshake never completes. `Browser.close` stops
 * it answering, and the next `attach` launches a healthy one on port 200.
 */
function runtime(
  overrides: Partial<ConnectDeps> & { wedged?: boolean; relaunchWedged?: boolean } = {},
) {
  const calls: string[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const state = { port: 100, alive: true, wedged: overrides.wedged ?? true };
  const deps: ConnectDeps = {
    attach: async () => {
      if (!state.alive) {
        state.port = 200;
        state.alive = true;
        state.wedged = overrides.relaunchWedged ?? false;
        calls.push("launch 200");
        return { httpEndpoint: "http://127.0.0.1:200", port: 200, launched: true, mode: "headless" };
      }
      calls.push(`attach ${state.port}`);
      return {
        httpEndpoint: `http://127.0.0.1:${state.port}`,
        port: state.port,
        launched: false,
        mode: "headless",
      };
    },
    connectOverCDP: async (endpoint) => {
      calls.push(`connect ${endpoint}`);
      return state.wedged ? never() : fakeBrowser(endpoint);
    },
    answers: async (port) => state.alive && port === state.port,
    quit: async () => {
      calls.push("quit");
      state.alive = false;
      return true;
    },
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    sleep: async () => {},
    connectTimeoutMs: 5,
    quitTimeoutMs: 5,
    goneTimeoutMs: 50,
    lockReleaseMs: 0,
    ...overrides,
  };
  return { connect: createConnector(deps), calls, logs, warns, state };
}

describe("connect", () => {
  it("control: a healthy endpoint connects and nothing is closed", async () => {
    const { connect, calls, logs, warns } = runtime({ wedged: false });
    await expect(connect()).resolves.toMatchObject({ name: "http://127.0.0.1:100" });
    expect(calls).toEqual(["attach 100", "connect http://127.0.0.1:100"]);
    expect(logs).toEqual([]);
    expect(warns).toEqual([]);
  });

  it("a wedged endpoint that still answers HTTP is closed ONCE, relaunched, and reported in one line", async () => {
    const { connect, calls, logs, warns } = runtime();
    await expect(connect()).resolves.toMatchObject({ name: "http://127.0.0.1:200" });
    expect(calls).toEqual([
      "attach 100",
      "connect http://127.0.0.1:100",
      "quit",
      "launch 200",
      "connect http://127.0.0.1:200",
    ]);
    expect(calls.filter((call) => call === "quit")).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/recovered a wedged browser endpoint: port 100 .* port 200 \(relaunched\) in \d+ms/);
    expect(warns).toEqual([]);
  });

  it("a timeout with the port NOT answering is unknown, never a restart", async () => {
    const { connect, calls, state } = runtime({
      answers: async () => false,
    });
    await expect(connect()).rejects.toThrow(/did not complete/);
    expect(calls).not.toContain("quit");
    expect(state.alive).toBe(true);
  });

  it("a failure that is not a timeout is reported, not recovered", async () => {
    const { connect, calls } = runtime({
      connectOverCDP: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(connect()).rejects.toThrow("ECONNREFUSED");
    expect(calls).not.toContain("quit");
  });

  it("a second failure inside the recovery stops: one quit, a warning, and no recovery on the next call", async () => {
    // The relaunched browser is wedged too.
    const { connect, calls, warns, logs } = runtime({ relaunchWedged: true });
    await expect(connect()).rejects.toThrow(/recovery failed .* Not retrying/);
    expect(calls.filter((call) => call === "quit")).toHaveLength(1);
    expect(warns).toHaveLength(1);
    expect(logs).toEqual([]);

    // The next call does NOT recover again: that would be the loop.
    await expect(connect()).rejects.toThrow(/did not complete/);
    expect(calls.filter((call) => call === "quit")).toHaveLength(1);
  });

  it("a browser that keeps answering after Browser.close is not relaunched over", async () => {
    const { connect, calls, warns } = runtime({
      quit: async () => true, // closed, as far as it says, but the port never goes quiet
    });
    await expect(connect()).rejects.toThrow(/still answered/);
    expect(calls).not.toContain("launch 200");
    expect(warns).toHaveLength(1);
  });

  it("a Browser.close that hangs is bounded and reported", async () => {
    const { connect, calls, warns } = runtime({ quit: () => new Promise<boolean>(() => {}) });
    await expect(connect()).rejects.toThrow(/could not close it/);
    expect(calls).not.toContain("launch 200");
    expect(warns).toHaveLength(1);
  });
});

describe("connect, against real Playwright", () => {
  it("a socket that connects but never answers the handshake is recognised as a wedge", async () => {
    const { createServer } = await import("node:http");
    const { chromium } = await import("./playwright-runtime.js");
    // The incident's shape: /json/version answers, the WebSocket upgrade is
    // accepted, and then nothing — no CDP reply ever comes back.
    const held: import("node:stream").Duplex[] = [];
    const server = createServer((request, response) => {
      const { port } = server.address() as import("node:net").AddressInfo;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/wedged` }),
      );
    });
    const { createHash } = await import("node:crypto");
    server.on("upgrade", (request, socket) => {
      held.push(socket);
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as import("node:net").AddressInfo;
    try {
      const quits: string[] = [];
      const connect = createConnector({
        attach: async () => ({
          httpEndpoint: `http://127.0.0.1:${port}`,
          port,
          launched: false,
          mode: "headless",
        }),
        connectOverCDP: (endpoint, timeout) => chromium().connectOverCDP(endpoint, { timeout }),
        answers: async () => true,
        quit: async () => {
          quits.push("quit");
          return true;
        },
        log: () => {},
        warn: () => {},
        sleep: async () => {},
        connectTimeoutMs: 300,
        goneTimeoutMs: 1,
      });
      // It still answers, so recovery stops at "still answered" — but only a
      // recognised timeout gets that far: anything else would rethrow as-is.
      const error = await connect().catch((caught: Error) => caught);
      expect(String(error)).toMatch(/wedged \(browserType\.connectOverCDP: Timeout 300ms exceeded\.\) .* still answered/);
      expect(String(error)).not.toContain("\n");
      expect(quits).toEqual(["quit"]);
    } finally {
      held.forEach((socket) => socket.destroy());
      server.close();
    }
  });
});
