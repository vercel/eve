import { describe, expect, it } from "vitest";

import { findModelInputSchemaProblem } from "#tools/model-input-schema-problem.js";

describe("findModelInputSchemaProblem", () => {
  it("accepts object schemas", () => {
    expect(
      findModelInputSchemaProblem({
        type: "object",
        properties: {
          city: { type: "string" },
          days: { type: ["integer", "null"] },
          tags: { type: "array", items: { type: "string" } },
          unit: {
            anyOf: [
              { type: "string", enum: ["c"] },
              { type: "string", enum: ["f"] },
            ],
          },
          extra: true,
        },
        required: ["city"],
        additionalProperties: false,
      }),
    ).toBeUndefined();
  });

  it("accepts an empty schema", () => {
    expect(findModelInputSchemaProblem({})).toBeUndefined();
  });

  it("warns about a root union", () => {
    expect(
      findModelInputSchemaProblem({ anyOf: [{ type: "object" }, { type: "object" }] }),
    ).toEqual({ message: expect.stringContaining('its root is "anyOf"'), severity: "warning" });
  });

  it.each([
    [{ type: "string" }, 'its root has type "string"'],
    [{ description: "City" }, "its root has no type"],
    [{ city: "string" }, "it maps field names to type names"],
    [
      { type: "object", properties: { city: { type: "text" } } },
      'inputSchema.properties.city has unknown type "text"',
    ],
    [
      { type: "object", properties: { city: "string" } },
      'inputSchema.properties.city is "string", not a JSON Schema object.',
    ],
    [
      { type: "object", properties: { list: { type: "array", items: { type: "str" } } } },
      'inputSchema.properties.list.items has unknown type "str"',
    ],
    [{ type: "object", required: "city" }, "inputSchema.required must be an array"],
  ])("reports %j", (schema, expected) => {
    expect(findModelInputSchemaProblem(schema)).toEqual({
      message: expect.stringContaining(expected),
      severity: "error",
    });
  });
});
