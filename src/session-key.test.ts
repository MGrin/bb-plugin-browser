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

  // A `thread.deleted` event for a row the host has already removed is the
  // ordinary way this happens, and the host answers it with null rather than
  // by throwing. Reading `.childOrigin` off that null threw a TypeError out
  // of the resolver, which the teardown could only warn about — leaving the
  // deleted thread's page open for the idle reaper to find half an hour later.
  it("treats a thread the host answers null for as its own root, without throwing", async () => {
    const bb = {
      sdk: { threads: { get: async () => null } },
    } as never;
    const resolve = createSessionKeyResolver(bb);
    // Its own id, not scratch and not a throw: the teardown compares the
    // resolved key with the thread id to decide whether this thread OWNS the
    // page, and only an exact match closes it.
    await expect(resolve("thr_deleted")).resolves.toBe("thr_deleted");
  });

  it("stops the walk at an ancestor the host answers null for", async () => {
    const bb = {
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            threadId === "child" ? { parentThreadId: "gone", childOrigin: "spawn" } : null,
        },
      },
    } as never;
    const resolve = createSessionKeyResolver(bb);
    await expect(resolve("child")).resolves.toBe("child");
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

  it("does not cache a transient fetch failure against a later real resolution", async () => {
    // "flaky" fails the first time it's fetched (as an ancestor of "child"),
    // then succeeds on a later, direct resolution. The first walk must not
    // poison the cache with a wrong mapping for "flaky".
    let flakyShouldFail = true;
    const bb = {
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => {
            if (threadId === "child") {
              return { parentThreadId: "flaky", childOrigin: "spawn" };
            }
            if (threadId === "flaky") {
              if (flakyShouldFail) {
                flakyShouldFail = false;
                throw new Error("transient failure");
              }
              return { parentThreadId: null, childOrigin: null };
            }
            throw new Error("no such thread");
          },
        },
      },
    } as never;
    const resolve = createSessionKeyResolver(bb);

    // First walk: "flaky"'s fetch throws, so the walk stops at "child".
    expect(await resolve("child")).toBe("child");

    // Resolving "flaky" directly, on the same resolver, must compute fresh
    // instead of returning the first walk's root ("child").
    expect(await resolve("flaky")).toBe("flaky");
  });
});
