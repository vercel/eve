import { describe, expect, it } from "vitest";

import { mergeObjects } from "#shared/objects.js";

describe("mergeObjects", () => {
  it("recursively merges records with overrides taking precedence", () => {
    expect(
      mergeObjects(
        { provider: { metadata: { safetyId: "default" }, setting: true } },
        { provider: { metadata: { safetyId: "authored" } } },
      ),
    ).toEqual({
      provider: {
        metadata: { safetyId: "authored" },
        setting: true,
      },
    });
  });

  it("replaces non-record values instead of merging them", () => {
    expect(
      mergeObjects(
        { array: [1], object: { nested: true }, primitive: "default" },
        { array: [2], object: null, primitive: undefined },
      ),
    ).toEqual({ array: [2], object: null, primitive: undefined });
  });
});
