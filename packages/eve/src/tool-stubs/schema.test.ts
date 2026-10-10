import { describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { parseToolStubs } from "#tool-stubs/rules.js";
import { StubPlayback } from "#tool-stubs/playback.js";

function matches(schema: JsonObject | boolean, value: JsonValue): boolean {
  const playback = new StubPlayback(
    parseToolStubs([
      { id: "rule", tool: "lookup", match: { value: schema }, outcome: { response: "matched" } },
    ]),
  );
  return playback.call({ callId: "call", tool: "lookup", input: { value } }).kind === "stub";
}

describe("supported tool stub constraints", () => {
  it("matches model-written text with string patterns", () => {
    const constraint = { type: "string", pattern: "\\b[Mm]ilk\\b" };
    for (const title of ["Buy milk", "Buy milk at the store", "Buy whole-fat milk"]) {
      expect(matches(constraint, title)).toBe(true);
    }
    expect(matches(constraint, "Walk the dog")).toBe(false);
    expect(matches(constraint, "Buy milkshake")).toBe(false);
    expect(matches(constraint, 42)).toBe(false);
  });

  it("matches scalar values without coercion", () => {
    expect(matches({ enum: ["open", 1, false, null] }, "open")).toBe(true);
    expect(matches({ enum: ["open", 1, false, null] }, "1")).toBe(false);
    expect(matches({ type: "number", minimum: 1, maximum: 3 }, 2)).toBe(true);
    expect(matches({ type: "number", minimum: 1, maximum: 3 }, 4)).toBe(false);
  });

  it("combines nested properties, array constraints, and alternatives", () => {
    const constraint = {
      type: "object",
      required: ["tags"],
      properties: {
        tags: { type: "array", items: { type: "string" }, contains: { const: "urgent" } },
        status: { anyOf: [{ const: "open" }, { const: "pending" }] },
      },
    };
    expect(matches(constraint, { tags: ["urgent"], extra: true })).toBe(true);
    expect(matches(constraint, { tags: ["urgent"], status: "pending" })).toBe(true);
    expect(matches(constraint, { tags: [] })).toBe(false);
    expect(matches(constraint, { tags: ["urgent"], status: "closed" })).toBe(false);
    expect(matches(constraint, {})).toBe(false);
  });

  it("does not mutate schemas or arguments or apply defaults", () => {
    const schema = { properties: { status: { default: "open" } } };
    const value = { untouched: true };
    expect(matches(schema, value)).toBe(true);
    expect(value).toEqual({ untouched: true });
    expect(schema).toEqual({ properties: { status: { default: "open" } } });
  });
});

const invalid: JsonObject[] = [
  { unknown: true },
  { $ref: "#" },
  { format: "email" },
  { $schema: "https://json-schema.org/draft/2020-12/schema" },
  { type: "strng" },
  { type: [] },
  { type: ["string", "string"] },
  { type: ["string", "invalid"] },
  { enum: [] },
  {
    enum: [
      { a: 1, b: 2 },
      { b: 2, a: 1 },
    ],
  },
  { title: 1 },
  { description: false },
  { minimum: "1" },
  { maximum: null },
  { exclusiveMinimum: true },
  { exclusiveMaximum: false },
  { multipleOf: 0.1 },
  { minLength: -1 },
  { maxLength: 0.5 },
  { pattern: 1 },
  { pattern: "[" },
  { minItems: -1 },
  { maxItems: 0.5 },
  { uniqueItems: true },
  { items: [] },
  { prefixItems: [] },
  { prefixItems: [1] },
  { contains: null },
  { minContains: 1 },
  { maxContains: 1 },
  { minProperties: -1 },
  { maxProperties: 0.5 },
  { properties: [] },
  { properties: { x: { unknown: true } } },
  { patternProperties: { "^s_": true } },
  { propertyNames: { pattern: "[" } },
  { propertyNames: 1 },
  { required: ["a", "a"] },
  { required: [1] },
  { additionalProperties: "false" },
  { dependentSchemas: { card: { required: ["address"] } } },
  { dependentRequired: { id: [] } },
  { const: {} },
  { const: [] },
  { enum: ["open", {}] },
  { enum: [[]] },
  { required: ["constructor"] },
  { properties: { toString: { type: "string" } } },
  { allOf: [{ properties: { value: { const: [] } } }] },
  { allOf: [] },
  { anyOf: [1] },
  { oneOf: [] },
  { not: 1 },
  { if: 1 },
  // oxlint-disable-next-line unicorn/no-thenable
  { then: 1 },
  { else: 1 },
  { allOf: [{ properties: { x: { pattern: "[" } } }] },
];

it.each(invalid)("rejects malformed or unsupported constraints at setup: %j", (schema) => {
  expect(() =>
    parseToolStubs([
      { id: "bad", tool: "lookup", match: { value: schema }, outcome: { response: null } },
    ]),
  ).toThrow();
});
