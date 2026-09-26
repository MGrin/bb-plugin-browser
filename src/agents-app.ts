// The agents' browser gets an app identity of its own on macOS.
//
// Launched straight from `/Applications/Brave Browser.app`, the agents'
// headless browser registers with LaunchServices as `com.brave.Browser` — the
// human's app. When the human's own Brave is not running (after a crash, or
// after a reboot if an agent opened a page first), clicking Brave in the Dock
// ACTIVATES THE HEADLESS ONE, which has no window, so the click does nothing.
// Measured 2026-09-26 (MX-1293): `lsappinfo` named the agents' pid as
// `com.brave.Browser`, and the human's profile held no lock.
//
// The fix is a private copy of the app under this plugin's data directory
// with its own CFBundleIdentifier (`<original>.bb-agents`), re-signed ad hoc
// because editing Info.plist breaks the vendor's signature. An APFS clone
// (`cp -c`) costs no disk until the original is updated, and the copy is
// re-made whenever the original's version changes, so it never runs a build
// older than the one installed.
//
// THE KEYCHAIN IS THE CATCH, and the reason the copy is gated below. Chromium
// on macOS encrypts cookies and saved passwords with a key it keeps in the
// login keychain ("Brave Safe Storage"), and that item's access list names the
// VENDOR'S signature. A re-signed copy cannot read it without a prompt, and
// the copy changes on every update. So the copy runs with
// `--use-mock-keychain`, whose key is a constant, and a profile that already
// holds keychain-encrypted data must be migrated once
// (`scripts/migrate-keychain.mjs`) before it switches. Until it is, it keeps
// launching exactly as before.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { platform } from "node:os";
import { promisify } from "node:util";

/**
 * Written in the profile by the migration script, or at first launch of a
 * profile with no data yet. Its presence is the ONLY thing that switches a
 * profile to the private app and the mock keychain.
 */
export const KEYCHAIN_FILE = "bb-keychain";

/**
 * Present while `scripts/migrate-keychain.mjs` is rewriting the profile. A
 * browser started mid-migration would write data under the key being retired,
 * so a launch refuses while it exists.
 */
export const MIGRATING_FILE = "bb-keychain-migrating";

/** Appended to the original bundle identifier. */
export const BUNDLE_ID_SUFFIX = ".bb-agents";

/**
 * Appended to the app's NAME, on disk and in Info.plist. A copy still called
 * "Brave Browser" is a second app LaunchServices can pick for
 * `open -a "Brave Browser"` or Spotlight, which is the confusion this exists
 * to remove.
 */
export const NAME_SUFFIX = " (agents)";

export type KeychainMode = "mock" | "system";

/**
 * Which keychain this profile's data is encrypted for.
 *
 * A profile with no Cookies and no Login Data has nothing encrypted yet, so it
 * starts on the mock keychain and the marker is written now. Anything else
 * without the marker is a profile whose logins live under the system keychain.
 */
export async function keychainMode(profileDir: string): Promise<KeychainMode> {
  const marker = join(profileDir, KEYCHAIN_FILE);
  try {
    return (await readFile(marker, "utf8")).trim() === "mock" ? "mock" : "system";
  } catch {
    // no marker: fall through
  }
  const holdsData = ["Cookies", "Login Data"].some((db) =>
    existsSync(join(profileDir, "Default", db)),
  );
  if (holdsData) return "system";
  await writeFile(marker, "mock\n", "utf8");
  return "mock";
}

/**
 * Whether a migration holds this profile. The lock names the migrating
 * process; a lock whose process is gone is stale — a run killed while it
 * waited on the keychain prompt — and is removed here, so a dead migration
 * can never keep the browser from launching.
 */
export function migrating(profileDir: string, alive = processAlive): boolean {
  const lock = join(profileDir, MIGRATING_FILE);
  let pid: number;
  try {
    pid = Number(readFileSync(lock, "utf8").trim());
  } catch {
    return false;
  }
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) return true;
  rmSync(lock, { force: true });
  return false;
}

/** Signal 0 tests for a process without touching it; EPERM still means alive. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The `.app` bundle a macOS binary lives in, or null when it is not in one. */
export function appBundleOf(binary: string, os = platform()): string | null {
  if (os !== "darwin") return null;
  const match = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(binary);
  return match?.[1] ?? null;
}

export type Run = (file: string, args: string[]) => Promise<string>;

const run: Run = async (file, args) => (await promisify(execFile)(file, args)).stdout;

interface Stamp {
  source: string;
  version: string;
}

/**
 * The private copy's executable, made or refreshed as needed.
 *
 * `appDir` holds the copy and a stamp naming the source and its version; a
 * matching stamp and an executable that exists mean nothing is done. The copy
 * is built beside the old one and swapped in by rename, so a failure leaves
 * the previous copy (or none) rather than half a bundle.
 */
export async function ensureAgentsApp(
  binary: string,
  appDir: string,
  exec: Run = run,
): Promise<string> {
  const bundle = appBundleOf(binary);
  if (!bundle) throw new Error(`not inside a macOS app bundle: ${binary}`);
  const plist = join(bundle, "Contents", "Info.plist");
  const version = (await exec("plutil", ["-extract", "CFBundleVersion", "raw", plist])).trim();
  const id = (await exec("plutil", ["-extract", "CFBundleIdentifier", "raw", plist])).trim();

  const appName = basename(bundle, ".app");
  const target = join(appDir, `${appName}${NAME_SUFFIX}.app`);
  const executable = join(target, "Contents", "MacOS", basename(binary));
  const stampFile = join(appDir, "stamp.json");
  const want: Stamp = { source: bundle, version };
  try {
    const have = JSON.parse(await readFile(stampFile, "utf8")) as Stamp;
    if (have.source === want.source && have.version === want.version && existsSync(executable)) {
      return executable;
    }
  } catch {
    // no stamp, or unreadable: rebuild
  }

  await mkdir(appDir, { recursive: true });
  const staging = join(appDir, `.staging-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  const staged = join(staging, basename(bundle));
  try {
    // -c is an APFS clone; without APFS it fails, and a real copy still works.
    await exec("cp", ["-c", "-R", bundle, staged]).catch(() => exec("cp", ["-R", bundle, staged]));
    const stagedPlist = join(staged, "Contents", "Info.plist");
    await exec("plutil", ["-replace", "CFBundleIdentifier", "-string", id + BUNDLE_ID_SUFFIX, stagedPlist]);
    for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
      await exec("plutil", ["-replace", key, "-string", appName + NAME_SUFFIX, stagedPlist]);
    }
    // codesign refuses a bundle carrying extended attributes ("detritus").
    await exec("xattr", ["-cr", staged]);
    await exec("codesign", ["--force", "--deep", "--sign", "-", staged]);
    await exec("codesign", ["--verify", "--deep", staged]);
    await rm(target, { recursive: true, force: true });
    await rename(staged, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await writeFile(stampFile, JSON.stringify(want), "utf8");
  return executable;
}

/** Where the private copy lives: beside the profile, never inside it. */
export function appDirFor(profileDir: string): string {
  return join(dirname(profileDir), "agents-app");
}
