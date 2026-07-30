import { describe, expect, it } from "vitest";

import { toDiagnosticMetadataValue } from "#evals/diagnostics.js";

describe("toDiagnosticMetadataValue", () => {
  it("preserves repeated references that are not circular", () => {
    const shared = { value: 1 };

    expect(toDiagnosticMetadataValue({ left: shared, right: shared })).toEqual({
      left: { value: 1 },
      right: { value: 1 },
    });
  });

  it("replaces references to ancestors as circular", () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(toDiagnosticMetadataValue(value)).toEqual({ self: "[Circular]" });
  });
});
