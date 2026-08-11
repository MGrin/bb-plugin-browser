import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi, PluginHttpHandler } from "@bb/plugin-sdk";
import type { Pages } from "./pages.js";
import type { Screencast } from "./screencast.js";
import { mjpegResponse, registerStreamRoute, STREAM_PATH } from "./stream.js";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

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
  // enqueues (header, body, trailer) fill it and push desiredSize negative,
  // so every one of the following 499 frames must be dropped, not queued.
  it("drops frames instead of queueing them for a slow client", async () => {
    let push: (frame: string) => void = () => {};
    const bigFrame = Buffer.alloc(100_000, 0xab).toString("base64");
    const response = await mjpegResponse(async (onFrame) => {
      push = onFrame;
      return () => {};
    });
    const reader = response.body!.getReader();

    for (let index = 0; index < 500; index++) push(bigFrame);

    // Exactly the first frame's three parts should have made it into the
    // stream's internal queue — drain them.
    for (let index = 0; index < 3; index++) {
      const { value } = await reader.read();
      expect(value).toBeDefined();
    }

    // A fourth read must NOT resolve promptly. If backpressure were not
    // honored, all 500 frames (1500 chunks) would already be sitting in the
    // queue and this would return immediately instead of timing out.
    const outcome = await Promise.race([
      reader.read().then(() => "resolved" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    expect(outcome).toBe("timeout");
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

function fakeScreencast(subscribe: Screencast["subscribe"] = vi.fn(async () => () => {})): Screencast {
  return {
    subscribe,
    dispatchInput: vi.fn(async () => {}),
    stopAll: vi.fn(),
  };
}

describe("registerStreamRoute", () => {
  it("registers a static GET path with token auth", () => {
    const { bb, routes } = fakeBbHttp();
    registerStreamRoute(
      bb,
      fakeScreencast(),
      { existingPageUrl: async () => null },
      async () => "scratch",
      async () => "main",
    );
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
    registerStreamRoute(bb, fakeScreencast(subscribe), { existingPageUrl }, resolveSessionKey, async () => "main");

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
    registerStreamRoute(bb, fakeScreencast(subscribe), { existingPageUrl }, resolveSessionKey, async () => "main");

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
    const subscribe = vi.fn(async (sessionKey: string, profile: string, onFrame: (f: string) => void) => {
      push = onFrame;
      return () => {};
    });
    registerStreamRoute(bb, fakeScreencast(subscribe), { existingPageUrl }, resolveSessionKey, async () => "main");

    const response = await routes[0].handler(fakeContext({ threadId: "thr_a" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("multipart/x-mixed-replace");
    expect(subscribe).toHaveBeenCalledWith("key-for-thr_a", "main", expect.any(Function));

    const reader = response.body!.getReader();
    push(jpeg);
    const chunk = await reader.read();
    expect(Buffer.from(chunk.value!).toString("binary")).toContain("Content-Type: image/jpeg");
    await reader.cancel();
  });
});
