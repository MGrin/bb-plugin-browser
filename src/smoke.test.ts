import { describe, expect, it } from "vitest";
import { pluginId } from "./identity.js";

describe("identity", () => {
  it("names the plugin", () => {
    expect(pluginId).toBe("browser");
  });
});
