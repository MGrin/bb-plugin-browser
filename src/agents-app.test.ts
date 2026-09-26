import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appBundleOf,
  appDirFor,
  BUNDLE_ID_SUFFIX,
  ensureAgentsApp,
  KEYCHAIN_FILE,
  keychainMode,
  migrating,
  MIGRATING_FILE,
  type Run,
} from "./agents-app.js";
import { launchArgs } from "./launch.js";

const scratch = () => mkdtemp(join(tmpdir(), "agents-app-"));

/**
 * A stand-in for the macOS tools: `cp` creates the executable the real copy
 * would, `plutil -extract` answers from `plist`, everything is recorded.
 */
function fakeTools(plist: Record<string, string>) {
  const calls: string[][] = [];
  const exec: Run = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "plutil" && args[0] === "-extract") return `${plist[args[1]!]}\n`;
    if (file === "cp") {
      const dest = args[args.length - 1]!;
      await mkdir(join(dest, "Contents", "MacOS"), { recursive: true });
      await writeFile(join(dest, "Contents", "MacOS", "Brave Browser"), "");
    }
    return "";
  };
  return { exec, calls };
}

const BINARY = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

describe("appBundleOf", () => {
  it("finds the bundle of a macOS app binary", () => {
    expect(appBundleOf(BINARY, "darwin")).toBe("/Applications/Brave Browser.app");
  });
  it("is null off macOS, where there is no app identity to share", () => {
    expect(appBundleOf(BINARY, "linux")).toBeNull();
  });
  it("is null for a binary that is not inside an app bundle", () => {
    expect(appBundleOf("/usr/local/bin/chromium", "darwin")).toBeNull();
  });
});

describe("ensureAgentsApp", () => {
  it("copies the app, gives it its own bundle id and re-signs it", async () => {
    if (!appBundleOf(BINARY)) return; // the bundle shape is macOS-only
    const dir = await scratch();
    const { exec, calls } = fakeTools({ CFBundleVersion: "154.1.96.59", CFBundleIdentifier: "com.brave.Browser" });
    const exe = await ensureAgentsApp(BINARY, dir, exec);
    expect(exe).toBe(join(dir, "Brave Browser (agents).app", "Contents", "MacOS", "Brave Browser"));
    expect(existsSync(exe)).toBe(true);
    const replace = calls.find((c) => c[0] === "plutil" && c[1] === "-replace");
    expect(replace).toContain(`com.brave.Browser${BUNDLE_ID_SUFFIX}`);
    expect(calls.some((c) => c[0] === "codesign" && c.includes("--sign"))).toBe(true);
    // A second app NAMED "Brave Browser" is what `open -a "Brave Browser"` could pick.
    const names = calls.filter((c) => c[0] === "plutil" && c[1] === "-replace" && c[2] !== "CFBundleIdentifier");
    expect(names.map((c) => c[2])).toEqual(["CFBundleName", "CFBundleDisplayName"]);
    expect(names.every((c) => c[4] === "Brave Browser (agents)")).toBe(true);
    // The id is set BEFORE signing: signing first would seal the vendor's id.
    const order = calls.map((c) => c[0] + (c[1] ?? ""));
    expect(order.indexOf("plutil-replace")).toBeLessThan(order.indexOf("codesign--force"));
  });

  it("does nothing when the copy matches the installed version", async () => {
    if (!appBundleOf(BINARY)) return;
    const dir = await scratch();
    const first = fakeTools({ CFBundleVersion: "1", CFBundleIdentifier: "com.brave.Browser" });
    await ensureAgentsApp(BINARY, dir, first.exec);
    const second = fakeTools({ CFBundleVersion: "1", CFBundleIdentifier: "com.brave.Browser" });
    await ensureAgentsApp(BINARY, dir, second.exec);
    expect(second.calls.some((c) => c[0] === "cp")).toBe(false);
  });

  it("re-makes the copy when the installed app is updated", async () => {
    if (!appBundleOf(BINARY)) return;
    const dir = await scratch();
    await ensureAgentsApp(BINARY, dir, fakeTools({ CFBundleVersion: "1", CFBundleIdentifier: "x" }).exec);
    const updated = fakeTools({ CFBundleVersion: "2", CFBundleIdentifier: "x" });
    await ensureAgentsApp(BINARY, dir, updated.exec);
    expect(updated.calls.some((c) => c[0] === "cp")).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "stamp.json"), "utf8")).version).toBe("2");
  });

  it("leaves no stamp when signing fails, so the next launch tries again", async () => {
    if (!appBundleOf(BINARY)) return;
    const dir = await scratch();
    const { exec } = fakeTools({ CFBundleVersion: "1", CFBundleIdentifier: "x" });
    const failing: Run = async (file, args) => {
      if (file === "codesign") throw new Error("signing failed");
      return exec(file, args);
    };
    await expect(ensureAgentsApp(BINARY, dir, failing)).rejects.toThrow(/signing failed/);
    expect(existsSync(join(dir, "stamp.json"))).toBe(false);
  });
});

describe("keychainMode", () => {
  it("puts a profile with no data yet on the mock keychain, and records it", async () => {
    const profile = await scratch();
    expect(await keychainMode(profile)).toBe("mock");
    expect((await readFile(join(profile, KEYCHAIN_FILE), "utf8")).trim()).toBe("mock");
  });

  it("keeps a profile holding logins on the system keychain until it is migrated", async () => {
    const profile = await scratch();
    await mkdir(join(profile, "Default"));
    await writeFile(join(profile, "Default", "Cookies"), "");
    expect(await keychainMode(profile)).toBe("system");
    expect(existsSync(join(profile, KEYCHAIN_FILE))).toBe(false);
  });

  it("follows the marker the migration writes", async () => {
    const profile = await scratch();
    await mkdir(join(profile, "Default"));
    await writeFile(join(profile, "Default", "Cookies"), "");
    await writeFile(join(profile, KEYCHAIN_FILE), "mock\n");
    expect(await keychainMode(profile)).toBe("mock");
  });
});

describe("migrating", () => {
  it("is true only while the migration's lock file exists", async () => {
    const profile = await scratch();
    expect(migrating(profile)).toBe(false);
    await writeFile(join(profile, MIGRATING_FILE), "");
    expect(migrating(profile)).toBe(true);
  });
});

describe("launchArgs", () => {
  it("adds the mock keychain only when asked", () => {
    expect(launchArgs("/p", "headless", true)).toContain("--use-mock-keychain");
    expect(launchArgs("/p", "headless", false)).not.toContain("--use-mock-keychain");
  });
  it("keeps the flags every launch needs", () => {
    const args = launchArgs("/p", "headed", true);
    expect(args).toContain("--user-data-dir=/p");
    expect(args).toContain("--disable-blink-features=AutomationControlled");
    expect(args).not.toContain("--headless=new");
    expect(args[args.length - 1]).toBe("about:blank");
  });
});

describe("appDirFor", () => {
  it("puts the copy beside the profile, never inside it", () => {
    expect(appDirFor("/d/plugins/browser/brave-agents")).toBe("/d/plugins/browser/agents-app");
  });
});
