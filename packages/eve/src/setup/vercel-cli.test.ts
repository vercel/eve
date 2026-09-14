import { describe, expect, it } from "vitest";

import { isVercelCliVersionSupported } from "./vercel-cli.js";

describe("isVercelCliVersionSupported", () => {
  it.each([
    ["59.15.0", "59.16.0", false],
    ["59.16.0", "59.16.0", true],
    ["60.0.0", "59.16.0", true],
    ["59.16.0-beta.1", "59.16.0", false],
    ["not-a-version", "59.16.0", false],
  ])("compares %s against %s", (version, minimumVersion, supported) => {
    expect(isVercelCliVersionSupported(version, minimumVersion)).toBe(supported);
  });
});
