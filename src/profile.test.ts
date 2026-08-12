import { describe, expect, it } from "vitest";
import { LEGACY_PROFILE_DIR_NAME, PROFILE_DIR_NAME, profileDirIn } from "./profile.js";

const never = () => false;
const always = () => true;

describe("profileDirIn", () => {
  it("uses the generic name on a fresh install", () => {
    expect(profileDirIn("/data", never)).toBe(`/data/plugins/browser/${PROFILE_DIR_NAME}`);
  });

  it("keeps an existing profile where it is — that directory holds the logins", () => {
    // Renaming would be tidier and is exactly the kind of tidiness that costs
    // somebody six re-logins if the directory turns out to be held.
    expect(profileDirIn("/data", always)).toBe(`/data/plugins/browser/${LEGACY_PROFILE_DIR_NAME}`);
  });

  it("checks for the legacy directory, not for the new one", () => {
    const asked: string[] = [];
    profileDirIn("/data", (path) => {
      asked.push(String(path));
      return false;
    });
    expect(asked).toEqual([`/data/plugins/browser/${LEGACY_PROFILE_DIR_NAME}`]);
  });

  it("never puts the agents' profile outside the plugin's own directory", () => {
    for (const exists of [never, always]) {
      expect(profileDirIn("/data", exists).startsWith("/data/plugins/browser/")).toBe(true);
    }
  });
});
