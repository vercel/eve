import { describe, expect, it } from "vitest";

import { normalizeSandboxDefinition } from "#internal/authored-definition/sandbox.js";

describe("normalizeSandboxDefinition", () => {
  it.each(["eager", "lazy"] as const)("accepts %s startup", (startup) => {
    expect(normalizeSandboxDefinition({ startup }, "invalid sandbox")).toMatchObject({
      startup,
    });
  });

  it("rejects an unsupported startup mode", () => {
    expect(() => normalizeSandboxDefinition({ startup: "automatic" }, "invalid sandbox")).toThrow(
      'invalid sandbox The "startup" field must be "eager" or "lazy" when set.',
    );
  });
});
