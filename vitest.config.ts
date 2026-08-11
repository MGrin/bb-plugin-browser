import { defineConfig } from "vitest/config";

export default defineConfig({
  // Root-level too: server.ts is the plugin entry and lives at the root
  // because the manifest points there, so its test does as well.
  test: { environment: "node", include: ["src/**/*.test.ts", "*.test.ts"] },
});
