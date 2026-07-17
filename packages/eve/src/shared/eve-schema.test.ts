import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { serializeEveSchema, toEveSchema } from "#shared/eve-schema.js";

describe("EveSchema", () => {
  it("rehydrates and validates serialized JSON Schema", async () => {
    const schema = toEveSchema({
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
    const schema = toEveSchema({
      items: { type: "string" },
      maxItems: 1,
      type: "array",
    });

    await expect(asSchema(schema).validate?.(["one", "too many"])).resolves.toMatchObject({
      success: false,
    });
  });

  it("rejects malformed serialized schemas at the runtime boundary", () => {
    expect(() => toEveSchema({ type: "not-a-json-schema-type" })).toThrow();
  });

  it("preserves a live validated schema", () => {
    const schema = z.object({ prompt: z.string() });

    expect(toEveSchema(schema)).toBe(schema);
  });

  it("serializes a runtime schema explicitly", () => {
    const schema = z.strictObject({ prompt: z.string() });

    expect(serializeEveSchema(schema)).toEqual({
      additionalProperties: false,
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      type: "object",
    });
  });
});
