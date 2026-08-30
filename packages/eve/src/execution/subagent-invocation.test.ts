import { asSchema } from "ai";
import { describe, expect, it } from "vitest";

import {
  normalizeRequestedOutputSchema,
  resolveSubagentOutputSchema,
} from "#execution/subagent-invocation.js";
import { toInputSchema } from "#tools/schema.js";

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

describe("resolveSubagentOutputSchema", () => {
  const declared = {
    additionalProperties: false,
    properties: {
      artifacts: {
        items: {
          additionalProperties: false,
          properties: { id: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        minItems: 1,
        type: "array",
      },
    },
    required: ["artifacts"],
    type: "object",
  } as const;

  it("preserves declared-only, caller-only, and empty-caller behavior", () => {
    const requested = { properties: { answer: { type: "string" } }, type: "object" };

    expect(resolveSubagentOutputSchema({ declared, requested: undefined })).toBe(declared);
    expect(resolveSubagentOutputSchema({ declared, requested: {} })).toBe(declared);
    expect(resolveSubagentOutputSchema({ declared: undefined, requested })).toBe(requested);
  });

  it("rejects fabricated ids and the wrong shard size after flattening the intersection", async () => {
    const effective = resolveSubagentOutputSchema({
      declared,
      requested: {
        properties: {
          artifacts: {
            items: { properties: { id: { enum: ["manifest-a", "manifest-b"] } } },
            maxItems: 2,
            minItems: 2,
          },
        },
      },
    });
    const validate = asSchema(toInputSchema(effective!)).validate;

    await expect(
      validate?.({ artifacts: [{ id: "manifest-a" }, { id: "fabricated" }] }),
    ).resolves.toMatchObject({ success: false });
    await expect(validate?.({ artifacts: [{ id: "manifest-a" }] })).resolves.toMatchObject({
      success: false,
    });
    await expect(
      validate?.({ artifacts: [{ id: "manifest-a" }, { id: "manifest-b" }] }),
    ).resolves.toMatchObject({ success: true });
  });

  it("fails closed when a requested schema cannot be flattened safely", () => {
    expect(() =>
      resolveSubagentOutputSchema({
        declared,
        requested: { allOf: [{ type: "object" }] },
      }),
    ).toThrow('cannot flatten the composition keyword "allOf"');
    expect(() =>
      resolveSubagentOutputSchema({
        declared,
        requested: { properties: { artifacts: { type: "string" } } },
      }),
    ).toThrow("declared and requested types do not overlap");
    expect(() =>
      resolveSubagentOutputSchema({
        declared,
        requested: {
          properties: {
            artifacts: {
              contains: { allOf: [{ properties: { id: { const: "manifest-a" } } }] },
            },
          },
        },
      }),
    ).toThrow(
      'outputSchema.properties.artifacts.contains: cannot flatten the composition keyword "allOf"',
    );
  });

  it("does not broaden a closed object with requested-only properties", async () => {
    const effective = resolveSubagentOutputSchema({
      declared: {
        additionalProperties: false,
        properties: { retained: { type: "string" } },
        type: "object",
      },
      requested: {
        properties: {
          requestedOnly: { type: "number" },
          retained: { maxLength: 10 },
        },
        type: "object",
      },
    });
    expect(effective).toEqual({
      additionalProperties: false,
      properties: { retained: { maxLength: 10, type: "string" } },
      type: "object",
    });
    await expect(
      asSchema(toInputSchema(effective!)).validate?.({ requestedOnly: 3 }),
    ).resolves.toMatchObject({ success: false });

    expect(() =>
      resolveSubagentOutputSchema({
        declared: {
          additionalProperties: false,
          properties: { retained: { type: "string" } },
          type: "object",
        },
        requested: {
          properties: { requestedOnly: { type: "number" } },
          required: ["requestedOnly"],
          type: "object",
        },
      }),
    ).toThrow("required properties are forbidden by the other schema: requestedOnly");
  });

  it("constrains a one-sided property map by the opposite additionalProperties", async () => {
    const effective = resolveSubagentOutputSchema({
      declared: { additionalProperties: false, type: "object" },
      requested: { properties: { requestedOnly: { type: "number" } }, type: "object" },
    });

    expect(effective).toEqual({
      additionalProperties: false,
      properties: {},
      type: "object",
    });
    await expect(
      asSchema(toInputSchema(effective!)).validate?.({ requestedOnly: 3 }),
    ).resolves.toMatchObject({ success: false });
    expect(() =>
      resolveSubagentOutputSchema({
        declared: { additionalProperties: false, type: "object" },
        requested: {
          properties: { requestedOnly: { type: "number" } },
          required: ["requestedOnly"],
          type: "object",
        },
      }),
    ).toThrow("required properties are forbidden by the other schema: requestedOnly");
  });

  it("rejects malformed one-sided schema keywords before runtime rehydration", () => {
    expect(() =>
      resolveSubagentOutputSchema({
        declared: { type: "object" },
        requested: { properties: { status: { enum: "oops" } }, type: "object" },
      }),
    ).toThrow("outputSchema.properties.status.enum: expected a non-empty array");
    expect(() =>
      resolveSubagentOutputSchema({
        declared: { type: "object" },
        requested: { properties: { status: { mysteryKeyword: true } }, type: "object" },
      }),
    ).toThrow("outputSchema.properties.status.mysteryKeyword: unsupported schema keyword");
  });

  it("applies an additionalProperties schema to properties explicit only on the other side", () => {
    expect(
      resolveSubagentOutputSchema({
        declared: {
          additionalProperties: { type: "string" },
          properties: {},
          type: "object",
        },
        requested: {
          properties: { requestedOnly: { maxLength: 10 } },
          type: "object",
        },
      }),
    ).toEqual({
      additionalProperties: { type: "string" },
      properties: { requestedOnly: { maxLength: 10, type: "string" } },
      type: "object",
    });

    expect(() =>
      resolveSubagentOutputSchema({
        declared: { patternProperties: { "^x": { type: "string" } }, type: "object" },
        requested: { properties: { x: { maxLength: 10 } }, type: "object" },
      }),
    ).toThrow('cannot flatten the property-evaluation keyword "patternProperties"');
  });
});
