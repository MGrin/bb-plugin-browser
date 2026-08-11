import { describe, expect, it } from "vitest";
import { createSessionKeyResolver, SCRATCH_SESSION_KEY } from "./session-key.js";

type Thread = { parentThreadId: string | null; childOrigin: string | null };

function fakeBb(threads: Record<string, Thread>) {
  return {
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads[threadId];
          if (!thread) throw new Error("no such thread");
          return thread;
        },
      },
    },
  } as never;
}

describe("createSessionKeyResolver", () => {
  it("returns scratch outside any thread", async () => {
    const resolve = createSessionKeyResolver(fakeBb({}));
    expect(await resolve(undefined)).toBe(SCRATCH_SESSION_KEY);
  });

  it("returns the thread itself when it has no parent", async () => {
    const resolve = createSessionKeyResolver(
      fakeBb({ a: { parentThreadId: null, childOrigin: null } }),
    );
    expect(await resolve("a")).toBe("a");
  });

  it("walks to the root so subagents share the coordinator's page", async () => {
    const resolve = createSessionKeyResolver(
      fakeBb({
        root: { parentThreadId: null, childOrigin: null },
        mid: { parentThreadId: "root", childOrigin: "spawn" },
        leaf: { parentThreadId: "mid", childOrigin: "spawn" },
      }),
    );
    expect(await resolve("leaf")).toBe("root");
  });

  it("stops at a fork, which is a peer exploration", async () => {
    const resolve = createSessionKeyResolver(
      fakeBb({
        root: { parentThreadId: null, childOrigin: null },
        forked: { parentThreadId: "root", childOrigin: "fork" },
      }),
    );
    expect(await resolve("forked")).toBe("forked");
  });

  it("stops at an unreadable ancestor instead of throwing", async () => {
    const resolve = createSessionKeyResolver(
      fakeBb({ child: { parentThreadId: "gone", childOrigin: "spawn" } }),
    );
    expect(await resolve("child")).toBe("child");
  });

  it("survives a parent cycle", async () => {
    const resolve = createSessionKeyResolver(
      fakeBb({
        a: { parentThreadId: "b", childOrigin: "spawn" },
        b: { parentThreadId: "a", childOrigin: "spawn" },
      }),
    );
    expect(await resolve("a")).toBe("b");
  });
});
