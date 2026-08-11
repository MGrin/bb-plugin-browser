// The invariant that used to be a comment.
//
// "Watching must never create a page or launch a browser" was enforced, for
// three tasks, by a pre-check in the stream route followed by a subscribe
// that resolved the page through the launch-capable path anyway — a comment
// asserting a property the code did not have, with a TOCTOU gap behind it.
// It is now enforced by what these modules are able to import at all: the
// read-only side cannot see `engine`, so there is no expression it could
// write that would start a browser.
//
// A test, and not just a code review, because the seam is one import away
// from being gone again and the mistake it prevents is silent: a plugin that
// spawns Chromium every time somebody opens a panel looks completely normal
// until you notice the process.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Every local module reachable from `entry`, following relative imports
 * transitively. Type-only imports count: this is a statement about what a
 * module is allowed to know, and a `type` import is how a launch-capable
 * dependency creeps back in one refactor before the call that uses it.
 */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(here, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      // Source is .ts; the emitted specifiers are .js, as ESM requires.
      const target = join(dirname(file), match[1]!.replace(/\.js$/, ".ts"));
      queue.push(target);
    }
  }
  return seen;
}

const names = (files: Set<string>) => [...files].map((file) => file.split("/").pop()!).sort();

describe("the trust seam between reading a page and creating one", () => {
  // page-registry.ts answers "is there a page, and where", and closes pages
  // that are already nobody's. The reaper, the stream route and the panel's
  // read path all go through it, and it runs unattended once a minute
  // forever — so it must have no way to start a browser at all.
  it("keeps the read-only page registry out of reach of the engine", () => {
    expect(names(reachableFrom("page-registry.ts"))).toEqual([
      "browser-endpoint.ts",
      "cdp.ts",
      "page-registry.ts",
    ]);
  });

  // The screencast takes a page's CDP url from its caller rather than
  // resolving one, which is what makes "watching never creates a page" true
  // in the window between the route's check and the subscribe, and not just
  // true of the check.
  it("keeps the screencast out of reach of anything that resolves a page", () => {
    expect(names(reachableFrom("screencast.ts"))).toEqual(["cdp.ts", "screencast.ts"]);
  });

  it("keeps the stream route out of reach of the engine and of pages.ts", () => {
    const reachable = names(reachableFrom("stream.ts"));
    expect(reachable).not.toContain("engine.ts");
    expect(reachable).not.toContain("pages.ts");
  });

  // The other half of the seam, stated from the other side: creating IS
  // allowed here, and only here (plus operations.ts, which drives commands).
  it("leaves pages.ts holding the engine, because binding a thread to a tab must create", () => {
    expect(names(reachableFrom("pages.ts"))).toContain("engine.ts");
  });
});
