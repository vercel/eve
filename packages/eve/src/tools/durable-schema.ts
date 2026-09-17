import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type {
  DurableCallbackJsonObject,
  StampedDurableDynamicCallback,
} from "#tools/durable-callbacks.js";
import {
  serializeInputSchema,
  serializeOutputSchema,
  toInputSchema,
  type ToolSchema,
  type ToolSchemaSource,
} from "#tools/schema.js";
import type { JsonObject } from "#shared/json.js";

const DURABLE_SCHEMA = Symbol.for("eve:durable-dynamic-schema");

export function hasSchemaValidator(source: unknown): source is StandardSchemaV1 {
  if (typeof source !== "object" || source === null || !("~standard" in source)) return false;
  const standard = source["~standard"];
  return (
    typeof standard === "object" &&
    standard !== null &&
    "validate" in standard &&
    typeof standard.validate === "function"
  );
}

type DurableSchema<TSchema> = TSchema extends undefined
  ? undefined
  : ToolSchema<
      TSchema extends StandardSchemaV1 ? StandardSchemaV1.InferInput<TSchema> : unknown,
      TSchema extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<TSchema> : unknown
    >;

/**
 * Defines a replayable schema for dynamic tools returned by provider packages.
 * Put per-tool values in `closure`; `schema` rebuilds the validator from that
 * JSON snapshot. Authored inline schema expressions are transformed automatically.
 */
export function defineDurableSchema<
  TClosure extends object,
  TSchema extends ToolSchemaSource | undefined,
>(input: {
  readonly closure: TClosure & DurableCallbackJsonObject<TClosure>;
  readonly schema: (closure: TClosure) => TSchema;
}): DurableSchema<TSchema> {
  const source = input.schema(input.closure);
  if (source === undefined) return undefined as DurableSchema<TSchema>;
  const validator = hasSchemaValidator(source) ? source : toInputSchema(source);
  const schema: ToolSchema = {
    "~standard": {
      version: 1,
      vendor: "eve",
      validate: (value) => validator["~standard"].validate(value),
      jsonSchema: {
        input: () => serializeInputSchema(source),
        output: () => serializeOutputSchema(source),
      },
    },
  };
  Object.defineProperty(schema, DURABLE_SCHEMA, {
    value: {
      callback: (closure: JsonObject) => input.schema(closure as TClosure),
      closure: input.closure as JsonObject,
    } satisfies StampedDurableDynamicCallback,
  });
  return schema as DurableSchema<TSchema>;
}

export function readDurableSchema(source: unknown): StampedDurableDynamicCallback | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  return Reflect.get(source, DURABLE_SCHEMA) as StampedDurableDynamicCallback | undefined;
}
