// Loading Playwright at runtime instead of bundling it.
//
// bb's plugin build bundles everything except `@bb/plugin-sdk` and
// `better-sqlite3`, and the list is not configurable. Playwright cannot be
// bundled: it ships a native fsevents binding and resolves chromium-bidi
// dynamically, both of which esbuild refuses.
//
// So it is required at run time from the plugin's own node_modules. The
// specifier is assembled rather than written literally for one reason: a
// literal would be statically visible to esbuild, which would try to bundle it
// again and fail the build exactly as before.
import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);

export interface PlaywrightChromium {
  connectOverCDP(endpoint: string): Promise<import("playwright-core").Browser>;
}

let cached: PlaywrightChromium | null = null;

export function chromium(): PlaywrightChromium {
  if (cached) return cached;
  const specifier = ["playwright", "core"].join("-");
  const loaded = requireFromHere(specifier) as { chromium: PlaywrightChromium };
  if (!loaded?.chromium) {
    throw new Error(
      "playwright-core is not installed next to this plugin — run `npm install` in the plugin directory",
    );
  }
  cached = loaded.chromium;
  return cached;
}
