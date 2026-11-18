import { describe, expect, it } from "vitest";

import { findModelInputSchemaProblem } from "#tools/model-input-schema-problem.js";

describe("findModelInputSchemaProblem", () => {
  it.each([
    [{ type: "object", properties: { city: { type: "string" } } }],
    [{ type: "object", anyOf: [{ type: "object" }] }],
    [{}],
  ])("accepts %j", (schema) => {
    expect(findModelInputSchemaProblem(schema)).toBeUndefined();
  });

  it.each([
    [{ type: "string" }, 'its root has type "string"'],
    [{ type: ["string", "number"] }, 'its root has type ["string","number"]'],
    [{ city: "string" }, "its root has no type"],
    [{ anyOf: [{ type: "object" }, { type: "object" }] }, 'its root is "anyOf"'],
  ])("reports %j", (schema, expected) => {
    expect(findModelInputSchemaProblem(schema)).toContain(expected);
  });
});
