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

  it("rejects malformed serialized schemas at the runtime boundary", () => {
    expect(() => toInputSchema({ type: "not-a-json-schema-type" })).toThrow();
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
