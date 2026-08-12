import { defineConfig } from "vitest/config";

// The live suite is separate from `npm test` on purpose: it starts a real
// Brave, takes tens of seconds, and is the only place this plugin's real
// failure modes are observable. Keeping it out of the fast suite is what
// stops anyone from being tempted to weaken it for speed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    // One browser, one profile: these tests share state deliberately, and
    // parallel files would fight over the same profile directory.
    fileParallelism: false,
  },
});
