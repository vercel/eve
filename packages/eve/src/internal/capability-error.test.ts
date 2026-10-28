import { describe, expect, it } from "vitest";

import { formatCapabilityError } from "#internal/capability-error.js";

describe("capability error diagnostics", () => {
  it("redacts raw and URL-encoded capabilities across the cause chain", () => {
    const parent = "parent:test-only-token";
    const child = "child:test-only-token";
    const error = new Error(`Backing store unavailable for ${parent}`, {
      cause: new Error(`Request /callback/${encodeURIComponent(child)} failed`),
    });

    const formatted = formatCapabilityError(error, [parent, child, undefined, ""]);
    const serialized = JSON.stringify(formatted);
    for (const token of [parent, child]) {
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(encodeURIComponent(token));
    }
    expect(formatted.message).toContain("Backing store unavailable");
    expect(formatted.detail).toContain("[redacted]");
    expect(formatted.detail).toContain("Request /callback/");
    expect(formatted.errorId).toEqual(expect.any(String));
  });
});
