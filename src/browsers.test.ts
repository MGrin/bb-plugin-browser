import { describe, expect, it } from "vitest";
import { candidates, detect, resolveBrowser } from "./browsers.js";

describe("candidates", () => {
  it("offers more than one vendor — the plugin is not Brave-only", () => {
    const names = candidates().map((candidate) => candidate.name);
    expect(new Set(names).size).toBeGreaterThan(2);
  });

  it("lists no path twice, so preference order is unambiguous", () => {
    const paths = candidates().map((candidate) => candidate.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("offers no non-Chromium browser: they cannot speak CDP at all", () => {
    // A Firefox or Safari entry would produce a browser that starts and then
    // never answers, which is far worse to diagnose than "none found".
    const joined = candidates()
      .map((candidate) => `${candidate.name} ${candidate.path}`)
      .join(" ")
      .toLowerCase();
    expect(joined).not.toMatch(/firefox|safari|webkit/);
  });
});

describe("resolveBrowser", () => {
  it("uses the configured path when it exists, whatever detection would say", () => {
    // An existing file that is certainly not the detected browser.
    const resolved = resolveBrowser(process.execPath);
    expect(resolved.path).toBe(process.execPath);
  });

  it("refuses a configured path that does not exist rather than silently falling back", () => {
    // Falling back would drive a DIFFERENT browser than the one named, with a
    // different profile — so a login would land somewhere nobody looked.
    expect(() => resolveBrowser("/nope/not/a/browser")).toThrow(/does not exist/);
  });

  it("ignores an empty or whitespace setting, which is how bb spells 'unset'", () => {
    const detected = detect();
    if (!detected) return;
    expect(resolveBrowser("").path).toBe(detected.path);
    expect(resolveBrowser("   ").path).toBe(detected.path);
    expect(resolveBrowser(undefined).path).toBe(detected.path);
  });

  it("names how to fix it when nothing is installed and nothing is configured", () => {
    // Only assertable on a machine with no browser; elsewhere the detection
    // path is the one under test above.
    if (detect()) return;
    expect(() => resolveBrowser()).toThrow(/browserPath/);
  });
});
