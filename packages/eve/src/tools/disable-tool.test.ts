import { describe, expect, it } from "vitest";

import { disableTool, isDisabledToolSentinel } from "#tools/definition.js";

describe("disableTool", () => {
  it("returns an opaque sentinel only disableTool() produces", () => {
    const sentinel = disableTool();

    expect(isDisabledToolSentinel(sentinel)).toBe(true);
    expect(Object.keys(sentinel)).toEqual([]);
    expect(isDisabledToolSentinel({ kind: "eve:disabled-tool" })).toBe(false);
  });
});
