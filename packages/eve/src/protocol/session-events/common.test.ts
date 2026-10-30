import { describe, expect, it } from "vitest";

import { z } from "#compiled/zod/index.js";

import { conforming } from "./common.js";

interface Shape {
  readonly id: string;
  readonly note?: string;
  readonly kind: "a" | "b";
  readonly tags: readonly string[];
}

// The cases are compile-time checks: each `@ts-expect-error` fails the build if it stops being
// one. The test only keeps them in a file that runs.
describe("conforming", () => {
  it("accepts a schema that parses to exactly the type", () => {
    const schema = conforming<Shape>()(
      z.object({
        id: z.string(),
        kind: z.enum(["a", "b"]),
        note: z.string().optional(),
        tags: z.array(z.string()),
      }),
    );
    expect(schema.parse({ id: "x", kind: "a", tags: [] })).toEqual({
      id: "x",
      kind: "a",
      tags: [],
    });
  });

  it("rejects a schema that drifted from the type", () => {
    const base = { id: z.string(), kind: z.enum(["a", "b"]), tags: z.array(z.string()) };
    const extraField = z.object({ ...base, extra: z.string(), note: z.string().optional() });
    const requiresOptional = z.object({ ...base, note: z.string() });
    const fewerValues = z.object({ ...base, kind: z.literal("a"), note: z.string().optional() });
    const missingField = z.object(base);
    const optionalRequired = z.object({ ...base, id: z.string().optional() });
    const drifted = [
      // @ts-expect-error a field the type doesn't have
      conforming<Shape>()(extraField),
      // @ts-expect-error a field the type leaves optional, required
      conforming<Shape>()(requiresOptional),
      // @ts-expect-error fewer values than the type allows
      conforming<Shape>()(fewerValues),
      // @ts-expect-error a field the type has, missing
      conforming<Shape>()(missingField),
      // @ts-expect-error a field the type requires, optional
      conforming<Shape>()(optionalRequired),
    ];
    expect(drifted).toHaveLength(5);
  });
});
