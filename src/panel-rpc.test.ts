import { describe, expect, it, vi } from "vitest";
import {
  createPanelRpcHandlers,
  panelRpcContract,
  toNavigableUrl,
  type PanelRpcDeps,
} from "./panel-rpc.js";
import type { InputEvent } from "./screencast.js";

const CLICK: InputEvent = {
  kind: "mouse",
  type: "mousePressed",
  x: 10,
  y: 20,
  button: "left",
  clickCount: 1,
};

function handlersWith(overrides: Partial<PanelRpcDeps> = {}) {
  const dispatchInput = vi.fn(async () => {});
  const open = vi.fn(async () => "opened");
  const existingPageInfo = vi.fn(async () => ({
    cdpUrl: "ws://127.0.0.1:9222/devtools/page/page-1",
    url: "https://example.com/",
  }));
  const deps: PanelRpcDeps = {
    pluginId: "browser",
    token: async () => "tok-secret",
    // A parent thread's key, so every test can prove the handler used the
    // resolver rather than the thread id it was handed.
    resolveSessionKey: async (threadId) => (threadId === "thr_child" ? "thr_root" : "thr_root"),
    operations: { open },
    pages: { existingPageInfo },
    screencast: { dispatchInput, viewportOf: () => ({ width: 1440, height: 900 }) },
    profileFor: async () => "main",
    ...overrides,
  };
  return { handlers: createPanelRpcHandlers(deps), dispatchInput, open, existingPageInfo };
}

describe("panelRpcContract", () => {
  it("refuses an input carrying a session key", () => {
    // The panel must never send or influence a session key — the server
    // derives it from the thread. A strict schema is what makes that
    // boundary impossible to cross by adding a field to a fetch call.
    const parsed = panelRpcContract.view.input.safeParse({
      threadId: "thr_a",
      sessionKey: "thr_someone_else",
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses an input event that is not one this plugin can dispatch", () => {
    expect(
      panelRpcContract.input.input.safeParse({
        threadId: "thr_a",
        event: { kind: "mouse", type: "explode", x: 1, y: 2, button: "left", clickCount: 1 },
      }).success,
    ).toBe(false);
  });

  it("refuses a coordinate that is not a finite number", () => {
    // NaN reaches CDP as a protocol error rather than a no-op, and Infinity
    // is not JSON-serializable — neither belongs on the wire.
    expect(
      panelRpcContract.input.input.safeParse({
        threadId: "thr_a",
        event: { ...CLICK, x: Number.POSITIVE_INFINITY },
      }).success,
    ).toBe(false);
  });
});

describe("toNavigableUrl", () => {
  it("assumes https for a bare host typed into the address bar", () => {
    expect(toNavigableUrl("example.com")).toBe("https://example.com");
  });

  it("leaves an explicit scheme alone, including one that will be refused", () => {
    expect(toNavigableUrl("http://example.com")).toBe("http://example.com");
    // Not this module's call to make: operations.open owns the scheme
    // allowlist, and quietly rewriting file:// to https://file:// would hide
    // the refusal the user should see.
    expect(toNavigableUrl("file:///etc/passwd")).toBe("file:///etc/passwd");
  });

  it("trims what a paste leaves behind", () => {
    expect(toNavigableUrl("  example.com\n")).toBe("https://example.com");
  });
});

describe("panel rpc handlers", () => {
  it("view reports the stream path, the token, and the page's current url", async () => {
    const { handlers } = handlersWith();
    expect(await handlers.view({ threadId: "thr_child" })).toEqual({
      streamPath: "/api/v1/plugins/browser/http/stream",
      token: "tok-secret",
      page: { url: "https://example.com/", viewport: { width: 1440, height: 900 } },
    });
  });

  it("view resolves the session key from the thread rather than trusting the caller", async () => {
    const { handlers, existingPageInfo } = handlersWith();
    await handlers.view({ threadId: "thr_child" });
    expect(existingPageInfo).toHaveBeenCalledWith("thr_root");
  });

  it("view reports no page instead of failing when the thread has never opened one", async () => {
    const { handlers } = handlersWith({ pages: { existingPageInfo: async () => null } });
    const result = await handlers.view({ threadId: "thr_a" });
    // "Nothing open here yet" is an ordinary state of a fresh thread, not an
    // error and not a reason to open anything.
    expect(result.page).toBeNull();
    expect(result.token).toBe("tok-secret");
  });

  it("view reports no viewport while nothing is casting", async () => {
    const { handlers } = handlersWith({
      screencast: { dispatchInput: vi.fn(async () => {}), viewportOf: () => null },
    });
    const result = await handlers.view({ threadId: "thr_a" });
    expect(result.page).toEqual({ url: "https://example.com/", viewport: null });
  });

  it("navigate opens the resolved session's page at the typed address", async () => {
    const { handlers, open } = handlersWith();
    expect(await handlers.navigate({ threadId: "thr_child", url: "example.com" })).toEqual({
      url: "https://example.com",
    });
    expect(open).toHaveBeenCalledWith("thr_root", "https://example.com");
  });

  it("input dispatches to the resolved session key and its profile", async () => {
    const { handlers, dispatchInput } = handlersWith();
    expect(await handlers.input({ threadId: "thr_child", event: CLICK })).toEqual({ ok: true });
    expect(dispatchInput).toHaveBeenCalledWith("thr_root", "main", CLICK);
  });

  it("input is dropped when nothing is casting, rather than opening a page to receive it", async () => {
    const dispatchInput = vi.fn(async () => {});
    const { handlers } = handlersWith({ screencast: { dispatchInput, viewportOf: () => null } });
    // A panel left open on a page that has since closed keeps its keyboard
    // focus. Dispatching would go through pageUrlFor and mint a blank tab
    // nobody asked for; a false here tells the panel to refresh instead.
    expect(await handlers.input({ threadId: "thr_a", event: CLICK })).toEqual({ ok: false });
    expect(dispatchInput).not.toHaveBeenCalled();
  });
});
