import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "#compiled/zod/index.js";
import { defineDurableSchema, readDurableSchema } from "#tools/durable-schema.js";
import { defineTool } from "#tools/definition.js";
import { serializeInputSchema, serializeOutputSchema } from "#tools/schema.js";

describe("defineDurableSchema", () => {
  it.each([false, true])("preserves nested Zod composition (frozen: %s)", (frozen) => {
    const source = z.object({ value: z.string().trim().min(1) });
    if (frozen) {
      // Zod installs its Standard Schema property lazily on first access.
      void source["~standard"];
      Object.freeze(source);
    }
    const schema = defineDurableSchema({ closure: {}, schema: () => source });
    const composed = z.discriminatedUnion("action", [
      z.object({ action: z.literal("echo"), input: schema as typeof source }),
    ]);

    expect(serializeInputSchema(composed)).toMatchObject({
      oneOf: [
        { properties: { input: { properties: { value: { type: "string", minLength: 1 } } } } },
      ],
    });
    expect(serializeOutputSchema(composed)).toMatchObject({
      oneOf: [
        { properties: { input: { properties: { value: { type: "string", minLength: 1 } } } } },
      ],
    });
    expect(composed.parse({ action: "echo", input: { value: " hello " } })).toEqual({
      action: "echo",
      input: { value: "hello" },
    });
    expect(composed.safeParse({ action: "echo", input: { value: " " } }).success).toBe(false);
    expect(readDurableSchema(source)).toBeUndefined();
  });

  it("leaves JSON-only schemas unchanged without adding a runtime validation contract", () => {
    const source = { type: "string", minLength: 1 };
    const schema = defineDurableSchema({ closure: {}, schema: () => source });
    expect(schema).toBe(source);
    expect(readDurableSchema(schema)).toBeUndefined();
    expectTypeOf(schema).toEqualTypeOf<typeof source>();
  });
  it("leaves absent optional output schemas undefined", () => {
    const schema = defineDurableSchema({ closure: {}, schema: () => undefined });
    expectTypeOf(schema).toEqualTypeOf<undefined>();
    expect(schema).toBeUndefined();
  });
  it("preserves inferred transformed input types", () => {
    const schema = defineDurableSchema({
      closure: { prefix: "value:" },
      schema: ({ prefix }) => z.object({ value: z.string().transform((value) => prefix + value) }),
    });
    defineTool({
      description: "Typed schema",
      inputSchema: schema,
      execute(input) {
        expectTypeOf(input).toEqualTypeOf<{ value: string }>();
        return input.value;
      },
    });
    expect(schema["~standard"].validate({ value: "a" })).toEqual({ value: { value: "value:a" } });
    expect(serializeInputSchema(schema)).toMatchObject({
      properties: { value: { type: "string" } },
    });
  });

  it("does not mutate shared or frozen schema objects", () => {
    const source = Object.freeze({ "~standard": z.object({ value: z.string() })["~standard"] });
    const first = defineDurableSchema({ closure: { version: 1 }, schema: () => source });
    const second = defineDurableSchema({ closure: { version: 2 }, schema: () => source });
    expect(readDurableSchema(source)).toBeUndefined();
    expect(readDurableSchema(first)?.closure).toEqual({ version: 1 });
    expect(readDurableSchema(second)?.closure).toEqual({ version: 2 });
  });
});
