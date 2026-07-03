import { describe, expect, it } from "vitest";

import { flattenTopLevelUnionToolInputSchema } from "#shared/json-schema.js";

describe("flattenTopLevelUnionToolInputSchema", () => {
  it("returns the original object unchanged when the top level is already an object", () => {
    const schema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };

    const result = flattenTopLevelUnionToolInputSchema(schema);

    expect(result.changed).toBe(false);
    expect(result.schema).toBe(schema);
  });

  it("flattens a top-level anyOf into a single permissive object schema", () => {
    const result = flattenTopLevelUnionToolInputSchema({
      anyOf: [
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
      ],
    });

    expect(result.changed).toBe(true);
    expect(result.schema).toEqual({
      type: "object",
      additionalProperties: true,
      properties: {
        id: { type: "string" },
        email: { type: "string" },
      },
    });
    // Branch-level `required` is dropped: branches disagree on which field
    // is present, so nothing is universally required.
    expect(result.schema).not.toHaveProperty("required");
  });

  it("flattens oneOf and allOf the same way", () => {
    for (const key of ["oneOf", "allOf"] as const) {
      const result = flattenTopLevelUnionToolInputSchema({
        [key]: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "object", properties: { b: { type: "number" } } },
        ],
      });
      expect(result.changed).toBe(true);
      expect(result.schema).toMatchObject({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
      });
      expect(result.schema).not.toHaveProperty(key);
    }
  });

  it("keeps the first branch's schema when property names collide", () => {
    const result = flattenTopLevelUnionToolInputSchema({
      anyOf: [
        { type: "object", properties: { value: { type: "string" } } },
        { type: "object", properties: { value: { type: "number" } } },
      ],
    });

    expect((result.schema.properties as Record<string, unknown>).value).toEqual({ type: "string" });
  });

  it("preserves top-level annotations and drops the union key", () => {
    const result = flattenTopLevelUnionToolInputSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      description: "Do a thing.",
      title: "DoThing",
      oneOf: [{ type: "object", properties: { x: { type: "string" } } }],
    });

    expect(result.schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      description: "Do a thing.",
      title: "DoThing",
      type: "object",
    });
    expect(result.schema).not.toHaveProperty("oneOf");
  });

  it("falls back to an empty permissive object when branches are not objects", () => {
    const result = flattenTopLevelUnionToolInputSchema({
      anyOf: [{ type: "string" }, { type: "number" }],
    });

    expect(result.schema).toEqual({
      type: "object",
      additionalProperties: true,
      properties: {},
    });
  });

  it("leaves nested unions untouched — only the top level is constrained", () => {
    const schema = {
      type: "object",
      properties: {
        target: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    };

    const result = flattenTopLevelUnionToolInputSchema(schema);

    expect(result.changed).toBe(false);
    expect(result.schema).toBe(schema);
  });
});
