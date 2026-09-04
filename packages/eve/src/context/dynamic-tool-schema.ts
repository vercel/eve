import type { JsonObject } from "#shared/json.js";
import { serializeInputSchema, type ToolSchemaSource } from "#tools/schema.js";

/** JSON Schema cannot persist executable validation or normalization logic. */
export function serializeDynamicToolInputSchema(
  name: string,
  source: ToolSchemaSource,
): JsonObject {
  const seen = new Set<object>();

  function unsupported(feature: string): never {
    throw new Error(
      `Dynamic tool "${name}" inputSchema contains ${feature}, which cannot be preserved in JSON Schema during replay. ` +
        "Use a JSON Schema-compatible inputSchema and move normalization or custom validation into execute().",
    );
  }

  function visit(value: unknown): void {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const record = value as Record<string, unknown>;
    const standard = record["~standard"] as { validate?: unknown } | undefined;
    if (typeof standard?.validate !== "function") {
      // Object shapes are maps of schemas, including getter-backed recursive fields.
      for (const item of Object.values(record)) visit(item);
      return;
    }
    const zod = record._zod as { def?: Record<string, unknown> } | undefined;
    const def = zod?.def ?? (record._def as Record<string, unknown> | undefined);
    if (def === undefined) unsupported("an unrecognized Zod validator");

    const type = def.typeName ?? def.type;
    if (
      type === "transform" ||
      type === "pipe" ||
      type === "custom" ||
      type === "catch" ||
      type === "ZodEffects" ||
      type === "ZodPipeline" ||
      type === "ZodCatch"
    ) {
      unsupported(`Zod ${String(type)}`);
    }
    if (def.coerce === true) unsupported("Zod coercion");

    for (const check of (def.checks ?? []) as Array<Record<string, unknown>>) {
      const checkDef = (check._zod as { def?: Record<string, unknown> } | undefined)?.def;
      const kind = checkDef?.check ?? check.kind;
      if (
        kind === "overwrite" ||
        kind === "custom" ||
        kind === "trim" ||
        kind === "toLowerCase" ||
        kind === "toUpperCase"
      ) {
        unsupported(`Zod ${String(kind)}`);
      }
    }

    if (type === "lazy" || type === "ZodLazy") {
      visit((def.getter as () => unknown)());
    }
    if (type === "ZodObject") visit((def.shape as () => unknown)());
    for (const key of [
      "shape",
      "innerType",
      "schema",
      "type",
      "element",
      "items",
      "options",
      "left",
      "right",
      "keyType",
      "valueType",
      "rest",
      "catchall",
    ]) {
      visit(def[key]);
    }
  }

  // Plain JSON Schema already declares the complete replay contract. Opaque
  // Standard Schema validators cannot prove that their emitted schema does.
  if ("~standard" in source) {
    const standard = source["~standard"] as { vendor?: string };
    if (standard.vendor !== "zod") unsupported("an opaque Standard Schema validator");
    visit(source);
  }
  return serializeInputSchema(source);
}
