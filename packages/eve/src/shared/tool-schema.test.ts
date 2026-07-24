import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  UNSPECIFIED_INPUT_SCHEMA,
  isToolSchema,
  serializeInputSchema,
  serializeOutputSchema,
  toInputSchema,
  toOutputSchema,
} from "#shared/tool-schema.js";

describe("ToolSchema", () => {
  it("rehydrates and validates serialized JSON Schema", async () => {
    const schema = toInputSchema({
      additionalProperties: false,
      properties: {
        prompt: { type: "string" },
      },
      required: ["prompt"],
      type: "object",
    });
    const validate = asSchema(schema).validate;

    await expect(validate?.({})).resolves.toMatchObject({ success: false });
    await expect(validate?.({ prompt: 42 })).resolves.toMatchObject({ success: false });
    await expect(validate?.({ extra: true, prompt: "Choose." })).resolves.toMatchObject({
      success: false,
    });
    await expect(validate?.({ prompt: "Choose." })).resolves.toEqual({
      success: true,
      value: { prompt: "Choose." },
    });
  });

  it("preserves JSON Schema constraints", async () => {
    const schema = toInputSchema({
      items: { type: "string" },
      maxItems: 1,
      type: "array",
    });

    await expect(asSchema(schema).validate?.(["one", "too many"])).resolves.toMatchObject({
      success: false,
    });
  });

  it("rehydrates draft 2020-12 $defs references with real validation", async () => {
    const schema = toInputSchema({
      $defs: { item: { type: "string" } },
      properties: { item: { $ref: "#/$defs/item" } },
      required: ["item"],
      type: "object",
    });
    const validate = asSchema(schema).validate;

    await expect(validate?.({ item: 42 })).resolves.toMatchObject({ success: false });
    await expect(validate?.({ item: "ok" })).resolves.toMatchObject({ success: true });
  });

  it("degrades schemas outside zod's conversion subset to validation-free passthrough", async () => {
    // Valid JSON Schema with an inline JSON Pointer $ref that zod's converter
    // rejects (it only resolves #, #/definitions/*, and #/$defs/*).
    const source = {
      properties: {
        filters: {
          anyOf: [
            { properties: { source: { type: "string" } }, type: "object" },
            {
              properties: {
                source: { $ref: "#/properties/filters/anyOf/0/properties/source" },
              },
              type: "object",
            },
          ],
        },
      },
      type: "object",
    };
    const schema = toInputSchema(source);

    expect(isToolSchema(schema)).toBe(true);
    // The source JSON Schema is advertised verbatim.
    expect(serializeInputSchema(schema)).toEqual(source);
    // Validation accepts any input — the tool's executor validates instead.
    await expect(asSchema(schema).validate?.({ filters: { source: 42 } })).resolves.toEqual({
      success: true,
      value: { filters: { source: 42 } },
    });
  });

  it("emits fresh copies from a passthrough schema so consumers cannot mutate the source", () => {
    const source = { properties: { x: { $ref: "#/properties/y" } }, type: "object" };
    const schema = toInputSchema(source);

    // asSchema's standardSchema path mutates the emitted JSON Schema in place.
    const emitted = asSchema(schema).jsonSchema as { additionalProperties?: boolean };

    expect(emitted.additionalProperties).toBe(false);
    expect(source).toEqual({ properties: { x: { $ref: "#/properties/y" } }, type: "object" });
    expect(serializeInputSchema(schema)).toEqual(source);
  });

  it("degrades malformed serialized schemas instead of failing the boundary", () => {
    expect(isToolSchema(toInputSchema({ type: "not-a-json-schema-type" }))).toBe(true);
  });

  it("preserves a live validated schema", () => {
    const schema = z.object({ prompt: z.string() });

    expect(toInputSchema(schema)).toBe(schema);
    expect(toOutputSchema(schema)).toBe(schema);
  });

  it("rehydrates one validator per serialized source object", () => {
    const source = {
      properties: { prompt: { type: "string" } },
      type: "object",
    };

    expect(toInputSchema(source)).toBe(toInputSchema(source));
  });

  it("passes null and undefined through every conversion", () => {
    expect(toInputSchema(null)).toBeNull();
    expect(toInputSchema(undefined)).toBeUndefined();
    expect(toOutputSchema(undefined)).toBeUndefined();
    expect(serializeInputSchema(null)).toBeNull();
    expect(serializeInputSchema(undefined)).toBeUndefined();
    expect(serializeOutputSchema(undefined)).toBeUndefined();
  });

  it("serializes a live schema to canonical JSON Schema data", () => {
    const schema = z.strictObject({ prompt: z.string() });

    expect(serializeInputSchema(schema)).toEqual({
      additionalProperties: false,
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      type: "object",
    });
  });

  it("strips the $schema version key from serialized data", () => {
    expect(
      serializeInputSchema({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
      }),
    ).toEqual({ type: "object" });
  });

  it("serializes each direction of a transforming schema", () => {
    const schema = z.strictObject({
      count: z
        .string()
        .transform((value) => Number.parseInt(value, 10))
        .pipe(z.number().int()),
    });

    expect(serializeInputSchema(schema)).toMatchObject({
      properties: { count: { type: "string" } },
    });
    expect(serializeOutputSchema(schema)).toMatchObject({
      properties: { count: expect.objectContaining({ type: "integer" }) },
    });
  });

  it("identifies validating JSON-Schema-capable values", () => {
    expect(isToolSchema(z.object({}))).toBe(true);
    expect(isToolSchema(UNSPECIFIED_INPUT_SCHEMA)).toBe(true);
    expect(isToolSchema({ type: "object" })).toBe(false);
    expect(isToolSchema(null)).toBe(false);
  });

  it("accepts any input via UNSPECIFIED_INPUT_SCHEMA", async () => {
    const validate = asSchema(UNSPECIFIED_INPUT_SCHEMA).validate;

    await expect(validate?.({})).resolves.toMatchObject({ success: true });
    await expect(validate?.({ extra: true })).resolves.toMatchObject({ success: true });
  });
});
