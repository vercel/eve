import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod/v3";

import { serializeDynamicToolInputSchema } from "#context/dynamic-tool-schema.js";
import { toInputSchema } from "#tools/schema.js";

describe("dynamic tool input schemas", () => {
  it.each([
    ["Zod 4 trim", z.object({ value: z.string().trim().min(1).optional() })],
    ["Zod 3 trim", z3.object({ value: z3.string().trim().min(1).optional() })],
  ])("rejects %s before replay can accept whitespace", async (_label, schema) => {
    expect(await schema["~standard"].validate({ value: " " })).toHaveProperty("issues");
    expect(() => serializeDynamicToolInputSchema("normalize", schema)).toThrow(
      /Dynamic tool "normalize" inputSchema contains Zod .*cannot be preserved.*move normalization or custom validation into execute\(\)/,
    );
  });

  it.each([
    ["transform", z.string().transform((value) => value.length)],
    ["overwrite", z.string().overwrite((value) => value.trim())],
    ["lowercase", z.string().toLowerCase()],
    ["uppercase", z.string().toUpperCase()],
    ["preprocess", z.preprocess(String, z.string())],
    ["coercion", z.coerce.number()],
    ["refinement", z.string().refine((value) => value !== "forbidden")],
    ["super refinement", z.string().superRefine(() => {})],
    ["custom", z.custom(() => true)],
    ["pipe", z.string().pipe(z.string().min(3))],
    ["catch", z.string().catch("fallback")],
    ["Zod 3 transform", z3.string().transform((value) => value.length)],
    ["Zod 3 refinement", z3.string().refine((value) => value !== "forbidden")],
    ["Zod 3 preprocess", z3.preprocess(String, z3.string())],
    ["Zod 3 lowercase", z3.string().toLowerCase()],
    ["Zod 3 uppercase", z3.string().toUpperCase()],
    ["Zod 3 coercion", z3.coerce.number()],
    ["Zod 3 pipe", z3.string().pipe(z3.string().min(3))],
    ["Zod 3 catch", z3.string().catch("fallback")],
  ])("rejects %s", (_label, schema) => {
    expect(() => serializeDynamicToolInputSchema("tool", schema)).toThrow(
      "cannot be preserved in JSON Schema during replay",
    );
  });

  it.each([
    ["array", z.array(z.string().trim())],
    ["tuple rest", z.tuple([]).rest(z.string().trim())],
    ["union", z.union([z.number(), z.string().trim()])],
    ["intersection", z.intersection(z.object({}), z.object({ value: z.string().trim() }))],
    ["record key", z.record(z.string().trim(), z.string())],
    ["record value", z.record(z.string(), z.string().trim())],
    ["catchall", z.object({}).catchall(z.string().trim())],
    ["nullable", z.string().trim().nullable()],
    ["default", z.string().trim().default("value")],
    ["lazy", z.lazy(() => z.string().trim())],
    ["Zod 3 array", z3.array(z3.string().trim())],
    ["Zod 3 lazy", z3.lazy(() => z3.string().trim())],
    [
      "schema-like property names",
      z.object({ _def: z.string(), _zod: z.string(), value: z.string().trim() }),
    ],
  ])("finds transformations inside %s", (_label, schema) => {
    expect(() => serializeDynamicToolInputSchema("nested", schema)).toThrow(
      "cannot be preserved in JSON Schema during replay",
    );
  });

  it.each([
    ["Zod 4", z.object({ value: z.string().min(1).regex(/\S/).optional() })],
    ["Zod 3", z3.object({ value: z3.string().min(1).regex(/\S/).optional() })],
  ])("replays supported %s validation after a JSON round trip", async (_label, source) => {
    const serialized = serializeDynamicToolInputSchema("validate", source);
    const validate = asSchema(toInputSchema(JSON.parse(JSON.stringify(serialized)))).validate;
    await expect(validate?.({ value: " " })).resolves.toMatchObject({ success: false });
    await expect(validate?.({ value: "valid" })).resolves.toMatchObject({ success: true });
    await expect(validate?.({})).resolves.toMatchObject({ success: true });
  });

  it("handles recursive schemas without revisiting them", () => {
    const schema = z.object({
      value: z.string(),
      get children() {
        return z.array(schema);
      },
    });
    expect(serializeDynamicToolInputSchema("tree", schema)).toMatchObject({ type: "object" });
  });

  it("requires opaque Standard Schema validators to declare their replay contract explicitly", () => {
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "custom",
        validate: (value: unknown) => ({ value }),
        jsonSchema: { input: () => ({ type: "string" }), output: () => ({ type: "string" }) },
      },
    };
    expect(() => serializeDynamicToolInputSchema("custom", schema)).toThrow(
      "an opaque Standard Schema validator",
    );
  });

  it("preserves plain JSON Schema without interpreting its data as Zod internals", () => {
    const schema = { type: "object", properties: { _def: { const: { type: "transform" } } } };
    expect(serializeDynamicToolInputSchema("remote", schema)).toEqual(schema);
  });
});
