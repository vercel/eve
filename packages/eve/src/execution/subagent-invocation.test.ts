import { describe, expect, it } from "vitest";

import { normalizeRequestedOutputSchema } from "#execution/subagent-invocation.js";

describe("normalizeRequestedOutputSchema", () => {
  it("passes a non-empty object schema through", () => {
    const schema = { properties: { answer: { type: "string" } }, type: "object" };

    expect(normalizeRequestedOutputSchema(schema)).toBe(schema);
  });

  it.each([
    ["an empty object", {}],
    ["a string", "object"],
    ["a number", 7],
    ["null", null],
    ["an array", [{ type: "object" }]],
  ])("normalizes %s to undefined", (_label, value) => {
    expect(normalizeRequestedOutputSchema(value)).toBeUndefined();
  });

  it("normalizes an absent value to undefined", () => {
    expect(normalizeRequestedOutputSchema(undefined)).toBeUndefined();
  });
});
