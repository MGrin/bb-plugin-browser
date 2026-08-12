import { afterEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi, PluginHttpHandler } from "@bb/plugin-sdk";
import { createPageRegistry } from "./page-registry.js";
import { createPages } from "./pages.js";
import type { Screencast } from "./screencast.js";
import { mjpegResponse, registerStreamRoute, STREAM_PATH } from "./stream.js";
import { fakeBrowser } from "./test-support/fake-browser.js";
import { fakeCdp, type FakeCdp } from "./test-support/fake-cdp.js";
import { memoryKv } from "./test-support/memory-kv.js";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
const BOUNDARY_MARKER = "--bbbrowserframe";

describe("mjpegResponse", () => {
  it("declares a multipart replace stream", async () => {
    const response = await mjpegResponse(async () => () => {});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("multipart/x-mixed-replace");
    expect(response.headers.get("content-type")).toContain("boundary=");
  });

  it("writes each frame as its own part", async () => {
    let push: (frame: string) => void = () => {};
    const response = await mjpegResponse(async (onFrame) => {
      push = onFrame;
      return () => {};
    });
    const reader = response.body!.getReader();
    push(jpeg);
    const chunk = await reader.read();
    const text = Buffer.from(chunk.value!).toString("binary");
    expect(text).toContain("Content-Type: image/jpeg");
    expect(text).toContain("Content-Length: 4");
    await reader.cancel();
  });

  // An <img> is the only client this route has, and a browser's multipart
  // parser paints a part when the NEXT boundary arrives, not when the part's
  // Content-Length bytes do. A page that renders once and then holds still
  // produces exactly one frame — so a writer that only prefixes each frame
  // with a boundary leaves that frame undecoded forever, and the panel stays
  // blank while the stream looks perfectly healthy. Measured in the real bb
  // app: naturalWidth stayed 0 through a complete, well-formed single frame.
  it("closes each frame's part with the next boundary, so one frame is enough to paint", async () => {
    let push: (frame: string) => void = () => {};
    const response = await mjpegResponse(async (onFrame) => {
      push = onFrame;
      return () => {};
    });
    const reader = response.body!.getReader();
    push(jpeg);
    const text = Buffer.from((await reader.read()).value!).toString("binary");
    const body = Buffer.from(jpeg, "base64").toString("binary");
    const bodyIndex = text.indexOf(body);
    expect(bodyIndex).toBeGreaterThan(-1);
    expect(text.indexOf(BOUNDARY_MARKER, bodyIndex)).toBeGreaterThan(bodyIndex);
    await reader.cancel();
  });

  it("unsubscribes when the client goes away", async () => {
    let unsubscribed = false;
    const response = await mjpegResponse(async () => () => {
      unsubscribed = true;
    });
    const reader = response.body!.getReader();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unsubscribed).toBe(true);
  });

  // Discriminates, unlike a bare "a chunk arrived" assertion: replacing the
  // desiredSize guard with `if (false)` (never drop) satisfies "a chunk
  // arrived" just as well as the real guard does, so that alone proves
  // nothing about backpressure. Pushing many large frames at a reader that
  // never reads and then asserting on how much got RETAINED is the only
  // version of this test a zero-backpressure implementation can't also
  // pass: the default 1-chunk high-water mark means the first frame's three
  // A live view wants the newest picture and never a queue of stale ones, so
  // frames are COALESCED rather than buffered — but coalescing must not mean
  // discarding. The version this replaced dropped any frame arriving while
  // the consumer had not drained, which on a page that repaints once and then
  // settles threw away the only frame there would ever be.
  it("keeps only the newest frame, never a backlog", async () => {
    let push: (frame: string) => void = () => {};
    const big = (byte: number) => Buffer.alloc(100_000, byte).toString("base64");
    const response = await mjpegResponse(async (onFrame) => {
      push = onFrame;
      return () => {};
    });
    const reader = response.body!.getReader();

    for (let index = 0; index < 500; index++) push(big(0xab));

    // One frame is in flight; the other 499 collapsed into a single pending
    // slot rather than a 50 MB queue.
    const first = (await reader.read()).value;
    expect(first).toBeDefined();
    const second = (await reader.read()).value;
    expect(second).toBeDefined();

    // Two reads, not 500 frames' worth of buffered bytes.
    const third = await Promise.race([
      reader.read().then(() => "resolved" as const),
      new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
    ]);
    expect(third).toBe("idle");
    await reader.cancel();
  });

  // The bug this exists for: a frame that arrives while the consumer has not
  // drained must be delivered when it does drain — not thrown away and left
  // to a repaint that never comes. This is the "clicked a button and the
  // image froze completely" case.
  it("delivers a frame that arrived while the consumer was busy", async () => {
    let push: (frame: string) => void = () => {};
    const response = await mjpegResponse(async (onFrame) => {
      push = onFrame;
      return () => {};
    });
    const reader = response.body!.getReader();

    // Frame 1 fills the one-chunk high-water mark.
    push(Buffer.from("FIRST").toString("base64"));
    // Frame 2 arrives with no room — the old code discarded it here.
    push(Buffer.from("SECOND").toString("base64"));

    const first = Buffer.from((await reader.read()).value!).toString("binary");
    expect(first).toContain("FIRST");

    // And now the page goes silent: nothing more is ever pushed. The second
    // frame must still arrive.
    const second = Buffer.from((await reader.read()).value!).toString("binary");
    expect(second).toContain("SECOND");
    await reader.cancel();
  });

  it("coalesces to the LATEST frame when several arrive while busy", async () => {
    let push: (frame: string) => void = () => {};
    const response = await mjpegResponse(async (onFrame) => {
      push = onFrame;
      return () => {};
    });
    const reader = response.body!.getReader();

    push(Buffer.from("FIRST").toString("base64"));
    push(Buffer.from("STALE").toString("base64"));
    push(Buffer.from("NEWEST").toString("base64"));

    expect(Buffer.from((await reader.read()).value!).toString("binary")).toContain("FIRST");
    // Not STALE: an intermediate frame nobody took is worthless.
    expect(Buffer.from((await reader.read()).value!).toString("binary")).toContain("NEWEST");
    await reader.cancel();
  });

  it("returns a real error status, not a broken 200, when subscribe rejects", async () => {
    const response = await mjpegResponse(async () => {
      throw new Error("no page open for this session");
    });
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).not.toContain("multipart");
    const text = await response.text();
    expect(text).toContain("no page open for this session");
  });

  // Deleting the enqueue try/catch's stop() call leaves every test above
  // passing, because every one of them reaches this catch (if at all) only
  // after a client-initiated cancel() has already set `stopped` and called
  // unsubscribe itself — the catch's own stop() call is redundant in that
  // path (see task-8-report.md for why: reader.cancel() invokes this
  // module's cancel() source hook, and therefore stop(), synchronously,
  // before the cancel() call even returns, so `stopped` is always already
  // true by the time a subsequent push() reaches onFrame).
  //
  // The catch exists for a DIFFERENT failure: a transport that errors the
  // controller directly without ever calling our cancel() hook (the comment
  // in stream.ts documents this; some runtimes surface a dropped connection
  // only this way). The public Response/ReadableStream reader API cannot
  // reach that state — cancelling always routes through our own hook — so
  // this test reaches into the controller the same way an external error
  // legitimately would, via a local subclass that captures it. Production
  // code (stream.ts) is untouched by this: the subclass only wraps the
  // global constructor for the lifetime of this one test.
  it("unsubscribes when a write fails without a client ever cancelling", async () => {
    let unsubscribed = false;
    let push: (frame: string) => void = () => {};
    let captured: ReadableStreamDefaultController<Uint8Array> | undefined;

    const RealReadableStream = globalThis.ReadableStream;
    class CapturingReadableStream<T> extends RealReadableStream<T> {
      constructor(source: UnderlyingSource<T> = {}, strategy?: QueuingStrategy<T>) {
        super(
          {
            ...source,
            start(controller) {
              captured = controller as unknown as ReadableStreamDefaultController<Uint8Array>;
              return source.start?.(controller);
            },
          },
          strategy,
        );
      }
    }
    globalThis.ReadableStream = CapturingReadableStream as unknown as typeof ReadableStream;

    try {
      await mjpegResponse(async (onFrame) => {
        push = onFrame;
        return () => {
          unsubscribed = true;
        };
      });

      // Errors the stream the way a runtime that never calls our cancel()
      // hook would — not via reader.cancel(), which (per the note above)
      // would always take the already-tested path instead.
      captured!.error(new Error("socket gone"));
      push(jpeg);

      expect(unsubscribed).toBe(true);
    } finally {
      globalThis.ReadableStream = RealReadableStream;
    }
  });
});

function fakeBbHttp() {
  const routes: {
    method: string;
    path: string;
    handler: PluginHttpHandler;
    opts?: { auth?: string };
  }[] = [];
  const bb = {
    http: {
      route: (method: string, path: string, handler: PluginHttpHandler, opts?: { auth?: string }) => {
        routes.push({ method, path, handler, opts });
      },
    },
  } as unknown as BbPluginApi;
  return { bb, routes };
}

function fakeContext(query: Record<string, string | undefined>): Parameters<PluginHttpHandler>[0] {
  return {
    req: { query: (key: string) => query[key] },
  } as unknown as Parameters<PluginHttpHandler>[0];
}

let server: FakeCdp;
afterEach(async () => { await server?.close(); });

/** The reaper's viewer refcount, as a ledger of who is watching what. */
function countingViewers() {
  const held = new Map<string, number>();
  const calls: string[] = [];
  return {
    held,
    calls,
    viewers: {
      watch: (sessionKey: string) => {
        calls.push(`watch ${sessionKey}`);
        held.set(sessionKey, (held.get(sessionKey) ?? 0) + 1);
      },
      unwatch: (sessionKey: string) => {
        calls.push(`unwatch ${sessionKey}`);
        held.set(sessionKey, (held.get(sessionKey) ?? 0) - 1);
      },
    },
  };
}

function fakeScreencast(subscribe: Screencast["subscribe"] = vi.fn(async () => () => {})): Screencast {
  return {
    subscribe,
    dispatchInput: vi.fn(async () => {}),
    viewportOf: () => null,
    stopAll: vi.fn(),
  };
}

describe("registerStreamRoute", () => {
  it("registers a static GET path with token auth", () => {
    const { bb, routes } = fakeBbHttp();
    registerStreamRoute(bb, {
      screencast: fakeScreencast(),
      pages: { existingPageUrl: async () => null },
      resolveSessionKey: async () => "scratch",
      viewers: countingViewers().viewers,
    });
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("GET");
    expect(routes[0].path).toBe(STREAM_PATH);
    // This plugin's own boundary of responsibility: the host's dispatcher
    // (not this route handler) is what actually rejects an unauthenticated
    // request for a "token"-mode route, before the handler ever runs — see
    // task-8-report.md. What's ours to prove is that the route is declared
    // with the mode that makes that enforcement happen at all.
    expect(routes[0].opts?.auth).toBe("token");
  });

  it("responds 400 and does nothing else when threadId is missing", async () => {
    const { bb, routes } = fakeBbHttp();
    const resolveSessionKey = vi.fn(async () => "key");
    const existingPageUrl = vi.fn(async () => "ws://x");
    const subscribe = vi.fn(async () => () => {});
    registerStreamRoute(bb, {
      screencast: fakeScreencast(subscribe),
      pages: { existingPageUrl },
      resolveSessionKey,
      viewers: countingViewers().viewers,
    });

    const response = await routes[0].handler(fakeContext({}));
    expect(response.status).toBe(400);
    expect(resolveSessionKey).not.toHaveBeenCalled();
    expect(existingPageUrl).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("responds 404 and never subscribes when the resolved session has no page", async () => {
    const { bb, routes } = fakeBbHttp();
    const resolveSessionKey = vi.fn(async (threadId: string | undefined) => `key-for-${threadId}`);
    const existingPageUrl = vi.fn(async () => null);
    const subscribe = vi.fn(async () => () => {});
    registerStreamRoute(bb, {
      screencast: fakeScreencast(subscribe),
      pages: { existingPageUrl },
      resolveSessionKey,
      viewers: countingViewers().viewers,
    });

    const response = await routes[0].handler(fakeContext({ threadId: "thr_a" }));
    expect(response.status).toBe(404);
    expect(resolveSessionKey).toHaveBeenCalledWith("thr_a");
    expect(existingPageUrl).toHaveBeenCalledWith("key-for-thr_a");
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("streams using the server-resolved session key, never the raw threadId", async () => {
    const { bb, routes } = fakeBbHttp();
    const resolveSessionKey = vi.fn(async (threadId: string | undefined) => `key-for-${threadId}`);
    const existingPageUrl = vi.fn(async (sessionKey: string) => (sessionKey === "key-for-thr_a" ? "ws://x" : null));
    let push: (frame: string) => void = () => {};
    // Mirrors real Screencast.subscribe: it never calls onFrame
    // synchronously from inside subscribe() itself — a real first frame
    // only arrives later, via an async CDP message, once subscribe() has
    // already returned and mjpegResponse has already wired up its
    // ReadableStream. Calling onFrame synchronously here (before that
    // stream exists) would make this fake unrepresentative of the real
    // dependency and drop the frame instead of testing anything.
    const subscribe = vi.fn(async (sessionKey: string, cdpUrl: string, onFrame: (f: string) => void) => {
      push = onFrame;
      return () => {};
    });
    registerStreamRoute(bb, {
      screencast: fakeScreencast(subscribe),
      pages: { existingPageUrl },
      resolveSessionKey,
      viewers: countingViewers().viewers,
    });

    const response = await routes[0].handler(fakeContext({ threadId: "thr_a" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("multipart/x-mixed-replace");
    // The url this route already resolved, handed straight to the
    // screencast: it has no way to resolve one for itself, which is what
    // makes "watching never creates a page" structural rather than a
    // pre-check with a TOCTOU gap behind it.
    expect(subscribe).toHaveBeenCalledWith("key-for-thr_a", "ws://x", expect.any(Function));

    const reader = response.body!.getReader();
    push(jpeg);
    const chunk = await reader.read();
    expect(Buffer.from(chunk.value!).toString("binary")).toContain("Content-Type: image/jpeg");
    await reader.cancel();
  });

  // The claim both this file and panel-rpc.ts make about session keys is
  // "derived here, never a parameter". That is worth exactly one thing —
  // no request can name a key of its own — and this is what proves it: a
  // sessionKey in the query is not read, not preferred, and not merged in.
  // (What it is NOT is isolation between threads: this route's auth is the
  // per-plugin token, which carries no caller identity, so anything local
  // holding it can name any thread id. Both files now say so.)
  it("ignores a session key offered in the query and uses the derived one", async () => {
    const { bb, routes } = fakeBbHttp();
    const resolveSessionKey = vi.fn(async (threadId: string | undefined) => `key-for-${threadId}`);
    const asked: string[] = [];
    const existingPageUrl = vi.fn(async (sessionKey: string) => {
      asked.push(sessionKey);
      return "ws://x";
    });
    const subscribe = vi.fn(async () => () => {});
    registerStreamRoute(bb, {
      screencast: fakeScreencast(subscribe),
      pages: { existingPageUrl },
      resolveSessionKey,
      viewers: countingViewers().viewers,
    });

    const response = await routes[0].handler(
      fakeContext({ threadId: "thr_a", sessionKey: "someone-elses-key" }),
    );
    expect(response.status).toBe(200);
    expect(asked).toEqual(["key-for-thr_a"]);
    expect(subscribe).toHaveBeenCalledWith("key-for-thr_a", "ws://x", expect.any(Function));
    await response.body!.cancel();
  });

  // Someone with the panel open is USING the page, even though no command
  // has run for an hour. Without this the idle reaper closes it under them
  // and the panel goes blank for no reason they can see.
  it("holds the page against the reaper for as long as a viewer is connected", async () => {
    const { bb, routes } = fakeBbHttp();
    const viewers = countingViewers();
    registerStreamRoute(bb, {
      screencast: fakeScreencast(),
      pages: { existingPageUrl: async () => "ws://x" },
      resolveSessionKey: async (threadId) => `key-for-${threadId}`,
      viewers: viewers.viewers,
    });

    const response = await routes[0].handler(fakeContext({ threadId: "thr_a" }));
    const reader = response.body!.getReader();
    expect(viewers.held.get("key-for-thr_a")).toBe(1);

    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Balanced, not merely released: an unwatch too many would let the next
    // viewer's page be reaped while they are still looking at it.
    expect(viewers.calls).toEqual(["watch key-for-thr_a", "unwatch key-for-thr_a"]);
    expect(viewers.held.get("key-for-thr_a")).toBe(0);
  });

  it("never counts a viewer for a request that never streamed", async () => {
    const { bb, routes } = fakeBbHttp();
    const viewers = countingViewers();
    registerStreamRoute(bb, {
      // A page that vanished between the route's existence check and the
      // subscribe — a phantom viewer here would hold the reaper off a
      // session nobody is actually watching, for the life of the plugin.
      screencast: fakeScreencast(async () => {
        throw new Error("page went away");
      }),
      pages: { existingPageUrl: async () => "ws://x" },
      resolveSessionKey: async () => "key-for-thr_a",
      viewers: viewers.viewers,
    });

    const missingThread = await routes[0].handler(fakeContext({}));
    expect(missingThread.status).toBe(400);

    const failed = await routes[0].handler(fakeContext({ threadId: "thr_a" }));
    expect(failed.status).toBe(502);
    expect(viewers.calls).toEqual([]);
  });
});

// End to end with the real Pages (not a stub for existingPageUrl): proves
// the whole route→pages chain, not just pages.ts in isolation, never falls
// back to a launch-capable lookup for a session whose browser is gone —
// the same defect class as "viewing creates a page", one level up.
describe("registerStreamRoute with the real Pages", () => {
  it("404s for a thread whose bound browser is gone, without ever calling engine.browserCdpUrl again", async () => {
    server = await fakeCdp();
    const browserCdpUrl = vi.fn(async () => server.url);
    const kv = memoryKv();
    const pages = createPages({
      // Exactly what PagesDeps.engine declares. `run` is there because a
      // page has to be created by the session that will drive it — only
      // `tab new --label` assigns the label the command path selects by.
      engine: {
        browserCdpUrl,
        run: fakeBrowser(server).run,
        shutdown: async () => {},
        shutdownAll: async () => {},
      },
      kv,
      registry: createPageRegistry({ kv, log: () => {} }),
      log: () => {},
    });

    // A real page, really created — the one call to browserCdpUrl this test
    // permits.
    await pages.pageUrlFor("key-for-thr_a", "main");
    expect(browserCdpUrl).toHaveBeenCalledTimes(1);

    // The browser (and the machine, in the scenario this regression-tests)
    // is gone by the time the stream request arrives.
    await server.close();

    const { bb, routes } = fakeBbHttp();
    registerStreamRoute(bb, {
      screencast: fakeScreencast(),
      pages,
      resolveSessionKey: async (threadId) => `key-for-${threadId}`,
      viewers: countingViewers().viewers,
    });

    const response = await routes[0].handler(fakeContext({ threadId: "thr_a" }));
    expect(response.status).toBe(404);
    // The whole point: a stream request against a stale binding must not
    // be the reason a browser process gets launched.
    expect(browserCdpUrl).toHaveBeenCalledTimes(1);
  });
});
