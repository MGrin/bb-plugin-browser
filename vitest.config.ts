import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Root-level too: server.ts is the plugin entry and lives at the root
    // because the manifest points there, so its test does as well.
    include: ["src/**/*.test.ts", "*.test.ts"],
    // The live suite starts a real Brave and has its own runner
    // (`npm run test:live`). It is kept out of the fast suite so this one
    // stays runnable anywhere — including inside the Bash sandbox, which
    // cannot launch a browser at all.
    exclude: ["src/**/*.integration.test.ts", "node_modules/**", "dist/**"],
  },
});
