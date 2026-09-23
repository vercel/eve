import { asSchema, jsonSchema, TypeValidationError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod/v3";

import {
  UNSPECIFIED_INPUT_SCHEMA,
  defineJsonSchema,
  isToolSchema,
  serializeInputSchema,
  serializeOutputSchema,
  toInputSchema,
  toModelSchema,
  toOutputSchema,
} from "#tools/schema.js";

const AI_SDK_SCHEMA = Symbol.for("vercel.ai.schema");

function validate(schema: object, value: unknown) {
  const result = (schema as ReturnType<typeof defineJsonSchema>)["~standard"].validate(value);
  if (result instanceof Promise) throw new Error("Expected synchronous validation.");
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("defineJsonSchema", () => {
  it("validates values against the JSON Schema", () => {
    const schema = defineJsonSchema({
      additionalProperties: false,
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      type: "object",
    });

    expect(validate(schema, {})).toEqual({
      issues: [{ message: 'Instance does not have required property "prompt".' }],
    });
    expect(validate(schema, { prompt: 42 })).toEqual({
      issues: [
        { message: 'Instance type "number" is invalid. Expected "string".', path: ["prompt"] },
      ],
    });
    expect(validate(schema, { extra: true, prompt: "Choose." })).toHaveProperty("issues");
    expect(validate(schema, { prompt: "Choose." })).toEqual({ value: { prompt: "Choose." } });
  });

  it("advertises the source schema verbatim through fresh copies", () => {
    const source = {
      anyOf: [{ required: ["page_id"] }, { required: ["data_source_id"] }],
      properties: {
        data_source_id: { type: "string" },
        page_id: { format: "uuid", type: "string" },
      },
      type: "object",
    };
    const schema = defineJsonSchema(source);
    const emitted = serializeInputSchema(schema) as Record<string, unknown>;

    expect(emitted).toEqual(source);
    expect(emitted).not.toBe(source);
    (emitted as { type: string }).type = "mutated";
    expect(serializeOutputSchema(schema)).toEqual(source);
  });

  it("enforces composition keywords that tool servers commonly emit", () => {
    const schema = defineJsonSchema({
      properties: {
        pages: {
          items: {
            anyOf: [{ required: ["page_id"] }, { required: ["title"] }],
            properties: { page_id: { type: "string" }, title: { type: "string" } },
            type: "object",
          },
          type: "array",
        },
        properties: {
          additionalProperties: { type: ["string", "number", "null"] },
          type: "object",
        },
        target: {
          allOf: [
            { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
            { properties: { kind: { enum: ["page", "database"] } }, type: "object" },
          ],
        },
        variant: {
          oneOf: [
            { properties: { mode: { const: "a" } }, required: ["mode"], type: "object" },
            { properties: { mode: { const: "b" } }, required: ["mode"], type: "object" },
          ],
        },
      },
      patternProperties: { "^x-": { type: "string" } },
      type: "object",
    });

    expect(
      validate(schema, {
        pages: [{ page_id: "1f2e3d4c5b6a79881f2e3d4c5b6a7988" }, { title: "Notes" }],
        properties: { Owner: "Bob", Points: 3, Status: null },
        target: { id: "db-1", kind: "database" },
        variant: { mode: "b" },
        "x-trace": "abc",
      }),
    ).toHaveProperty("value");
    expect(validate(schema, { pages: [{}] })).toHaveProperty("issues");
    expect(validate(schema, { properties: { Owner: {} } })).toHaveProperty("issues");
    expect(validate(schema, { target: { kind: "page" } })).toHaveProperty("issues");
    expect(validate(schema, { variant: { mode: "c" } })).toHaveProperty("issues");
    expect(validate(schema, { "x-trace": 1 })).toHaveProperty("issues");
  });

  it("resolves $defs, definitions, and inline JSON Pointer references", () => {
    const schema = defineJsonSchema({
      $defs: { item: { type: "string" } },
      definitions: { count: { type: "integer" } },
      properties: {
        count: { $ref: "#/definitions/count" },
        item: { $ref: "#/$defs/item" },
        same: { $ref: "#/properties/item" },
      },
      type: "object",
    });

    expect(validate(schema, { count: 1, item: "ok", same: "ok" })).toHaveProperty("value");
    expect(validate(schema, { item: 42 })).toHaveProperty("issues");
    expect(validate(schema, { count: 1.5 })).toHaveProperty("issues");
    expect(validate(schema, { same: 42 })).toHaveProperty("issues");
  });

  it("treats format as an annotation", () => {
    const schema = defineJsonSchema({
      properties: { page_id: { format: "uuid", type: "string" } },
      type: "object",
    });

    expect(validate(schema, { page_id: "1f2e3d4c5b6a79881f2e3d4c5b6a7988" })).toHaveProperty(
      "value",
    );
    expect(serializeInputSchema(schema)).toEqual({
      properties: { page_id: { format: "uuid", type: "string" } },
      type: "object",
    });
  });

  it("reports only the deepest failure of each chain with its path", () => {
    const schema = defineJsonSchema({
      properties: {
        pages: {
          items: { properties: { "a/b": { type: "string" } }, type: "object" },
          type: "array",
        },
      },
      type: "object",
    });

    expect(validate(schema, { pages: [{ "a/b": 1 }] })).toEqual({
      issues: [
        {
          message: 'Instance type "number" is invalid. Expected "string".',
          path: ["pages", "0", "a/b"],
        },
      ],
    });
  });

  it.each([
    ["an unknown type name", { properties: { value: { type: "any" } }, type: "object" }],
    ["a non-array enum", { properties: { state: { enum: "open" } }, type: "object" }],
    ["an invalid pattern", { properties: { id: { pattern: "(?i)abc", type: "string" } } }],
    ["an invalid pattern property", { patternProperties: { "(?i)x": { type: "string" } } }],
    ["a non-array required", { required: "id", type: "object" }],
    ["an unresolvable reference", { properties: { a: { $ref: "https://example.com/a.json" } } }],
  ])("advertises %s but passes values through unvalidated", (_label, source) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = defineJsonSchema(source);

    expect(serializeInputSchema(schema)).toEqual(source);
    expect(validate(schema, { a: 1, id: 1, state: 1, value: 1, x: 1 })).toEqual({
      value: { a: 1, id: 1, state: 1, value: 1, x: 1 },
    });
    expect(validate(schema, { a: 2 })).toEqual({ value: { a: 2 } });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("runs the extra check only after the JSON Schema accepts a value", () => {
    const check = vi.fn((value: { readonly labels: readonly string[] }) =>
      new Set(value.labels).size === value.labels.length ? undefined : "Labels must be unique.",
    );
    const schema = defineJsonSchema(
      { properties: { labels: { items: { type: "string" }, type: "array" } }, type: "object" },
      check,
    );

    expect(validate(schema, { labels: ["a", "b"] })).toEqual({ value: { labels: ["a", "b"] } });
    expect(validate(schema, { labels: ["a", "a"] })).toEqual({
      issues: [{ message: "Labels must be unique." }],
    });
    expect(validate(schema, { labels: [1] })).toHaveProperty("issues");
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("does not mutate the source while validating", () => {
    const source = {
      properties: { id: { format: "uuid", type: "string" } },
      type: "object",
    };
    const snapshot = structuredClone(source);
    const schema = defineJsonSchema(source);

    validate(schema, { id: "x" });

    expect(source).toEqual(snapshot);
    expect(Object.getOwnPropertyNames(source)).toEqual(Object.getOwnPropertyNames(snapshot));
  });
});

describe("toModelSchema", () => {
  it("lowers Standard Schemas onto AI SDK schemas the AI SDK uses as-is", async () => {
    const sources = [
      defineJsonSchema({ properties: { city: { type: "string" } }, type: "object" }),
      z.strictObject({ city: z.string() }),
    ];

    for (const source of sources) {
      const modelSchema = toModelSchema(source, "input") as object;

      expect(Reflect.get(modelSchema, AI_SDK_SCHEMA)).toBe(true);
      expect("~standard" in modelSchema).toBe(false);
      expect("_zod" in modelSchema).toBe(false);
      expect(asSchema(modelSchema as Parameters<typeof asSchema>[0])).toBe(modelSchema);
      await expect(asSchema(modelSchema as never).validate?.({ city: "Paris" })).resolves.toEqual({
        success: true,
        value: { city: "Paris" },
      });
    }
  });

  it("emits JSON Schema from the source's own library", async () => {
    const zodSchema = z.strictObject({ city: z.string() });
    const jsonSource = { properties: { city: { type: "string" } }, type: "object" };

    expect(await asSchema(toModelSchema(zodSchema, "input")).jsonSchema).toEqual(
      serializeInputSchema(zodSchema),
    );
    expect(await asSchema(toModelSchema(defineJsonSchema(jsonSource), "input")).jsonSchema).toEqual(
      jsonSource,
    );
  });

  it("emits the requested direction of a transforming schema", async () => {
    const schema = z.strictObject({
      count: z
        .string()
        .transform((value) => Number.parseInt(value, 10))
        .pipe(z.number().int()),
    });

    expect(await asSchema(toModelSchema(schema, "output")).jsonSchema).toMatchObject({
      properties: { count: expect.objectContaining({ type: "integer" }) },
    });
    await expect(
      asSchema(toModelSchema(schema, "input")).validate?.({ count: "7" }),
    ).resolves.toEqual({ success: true, value: { count: 7 } });
  });

  it("reports validation failures as AI SDK type validation errors with the issues", async () => {
    const schema = toModelSchema(
      defineJsonSchema({ properties: { city: { type: "string" } }, type: "object" }),
      "input",
    );

    const result = await asSchema(schema).validate?.({ city: 1 });

    expect(result).toMatchObject({ success: false });
    const error = (result as { readonly error: unknown }).error;
    expect(TypeValidationError.isInstance(error)).toBe(true);
    expect((error as TypeValidationError).cause).toEqual([
      { message: 'Instance type "number" is invalid. Expected "string".', path: ["city"] },
    ]);
  });

  it("passes AI SDK-native and absent schemas through", () => {
    const native = jsonSchema({ type: "object" });
    const lazy = () => native;

    expect(toModelSchema(native, "input")).toBe(native);
    expect(toModelSchema(lazy, "input")).toBe(lazy);
    expect(toModelSchema(undefined, "output")).toBeUndefined();
  });
});

describe("tool schema conversion", () => {
  it("resolves plain JSON Schema into a validating schema", () => {
    const schema = toInputSchema({ items: { type: "string" }, maxItems: 1, type: "array" });

    expect(isToolSchema(schema)).toBe(true);
    expect(validate(schema, ["one", "too many"])).toHaveProperty("issues");
  });

  it("preserves a live validated schema", () => {
    const schema = z.object({ prompt: z.string() });

    expect(toInputSchema(schema)).toBe(schema);
    expect(toOutputSchema(schema)).toBe(schema);
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

  it("serializes and validates a Zod 3 input schema", async () => {
    const source = z3.object({ city: z3.string() });

    expect(serializeInputSchema(source)).toEqual({
      additionalProperties: false,
      properties: { city: { type: "string" } },
      required: ["city"],
      type: "object",
    });

    const modelSchema = asSchema(toModelSchema(toInputSchema(source), "input"));
    await expect(modelSchema.validate?.({ city: "San Francisco" })).resolves.toMatchObject({
      success: true,
    });
    await expect(modelSchema.validate?.({ city: 42 })).resolves.toMatchObject({ success: false });
  });

  it("rejects a Zod 3 output schema with an actionable error", () => {
    expect(() => serializeOutputSchema(z3.object({ city: z3.string() }))).toThrow(
      "Zod 3 cannot emit an output JSON Schema. Upgrade to Zod 4 or provide a plain JSON Schema object.",
    );
  });

  it("explains when a Standard Schema cannot emit JSON Schema", () => {
    const schema = {
      "~standard": {
        validate: (value: unknown) => ({ value }),
        vendor: "example",
        version: 1 as const,
      },
    };

    expect(() => serializeInputSchema(schema)).toThrow(
      'Standard Schema vendor "example" does not support JSON Schema conversion. Provide a Standard Schema implementation with JSON Schema conversion or a plain JSON Schema object.',
    );
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

  it("accepts any input via UNSPECIFIED_INPUT_SCHEMA", () => {
    expect(validate(UNSPECIFIED_INPUT_SCHEMA, {})).toEqual({ value: {} });
    expect(validate(UNSPECIFIED_INPUT_SCHEMA, { extra: true })).toEqual({
      value: { extra: true },
    });
  });
});
