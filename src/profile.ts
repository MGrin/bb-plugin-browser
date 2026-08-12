// Where the agents' profile lives.
//
// This is a whole module for one path because the path is not quite constant:
// the plugin shipped with the directory named `brave-agents`, back when Brave
// was the only browser it drove. New installs get the honest generic name;
// existing ones keep the directory they already have, because that directory
// is where every login is and moving a live Chromium's user-data-dir to
// improve a name is a bad trade.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** What a fresh install uses. Not browser-specific — any Chromium can hold it. */
export const PROFILE_DIR_NAME = "agents-profile";

/** What installs before 2026-08-12 use; kept in place when found. */
export const LEGACY_PROFILE_DIR_NAME = "brave-agents";

/**
 * The profile directory for this machine.
 *
 * Deliberately NOT a migration: renaming would be tidier, but a rename can
 * only be safe if nothing holds the directory, and "nothing holds it" is not
 * something this can establish from the outside — a browser mid-launch has the
 * lock before it publishes a port. An old name is cosmetic; a broken profile
 * is somebody logging into six sites again.
 */
export function profileDirIn(dataDir: string, exists = existsSync): string {
  const base = join(dataDir, "plugins", "browser");
  const legacy = join(base, LEGACY_PROFILE_DIR_NAME);
  if (exists(legacy)) return legacy;
  return join(base, PROFILE_DIR_NAME);
}
