import { describe, expect, it } from "vitest";

import { normalizeRequestedOutputSchema } from "#subagents/invocation.js";

describe("normalizeRequestedOutputSchema", () => {
  it("passes a non-empty object schema through", () => {
    const schema = { properties: { answer: { type: "string" } }, type: "object" };

    expect(normalizeRequestedOutputSchema(schema)).toBe(schema);
  });

  it.each([
    ["an empty object", {}],
    ["a non-JSON string", "object"],
    ["a number", 7],
    ["null", null],
    ["an array", [{ type: "object" }]],
  ])("normalizes %s to undefined", (_label, value) => {
    expect(normalizeRequestedOutputSchema(value)).toBeUndefined();
  });

  it("decodes a non-empty JSON object schema", () => {
    const schema = { properties: { answer: { type: "string" } }, type: "object" };

    expect(normalizeRequestedOutputSchema(JSON.stringify(schema))).toEqual(schema);
  });

  it("normalizes an absent value to undefined", () => {
    expect(normalizeRequestedOutputSchema(undefined)).toBeUndefined();
  });
});
