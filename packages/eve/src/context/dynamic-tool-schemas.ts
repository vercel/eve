import { randomUUID } from "node:crypto";

import type { CurrentDynamicToolMetadata } from "#context/dynamic-tool-metadata.js";
import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import {
  isToolSchema,
  toInputSchema,
  toOutputSchema,
  type ToolSchema,
  type ToolSchemaSource,
} from "#tools/schema.js";

export interface DynamicToolSchemaReference {
  readonly id: string;
  readonly input: boolean;
  readonly output: boolean;
}

interface LiveToolSchemas {
  readonly input?: ToolSchema;
  readonly output?: ToolSchema;
}

const REGISTRY = Symbol.for("eve:dynamic-tool-schemas");
const MAX_CACHED_SCHEMAS = 2_048;

type SchemaRegistry = Map<string, LiveToolSchemas>;

function registry(): SchemaRegistry {
  const global = globalThis as Record<symbol, SchemaRegistry | undefined>;
  return (global[REGISTRY] ??= new Map());
}

function lookup(id: string): LiveToolSchemas | undefined {
  const schemas = registry();
  const value = schemas.get(id);
  if (value !== undefined) {
    schemas.delete(id);
    schemas.set(id, value);
  }
  return value;
}

function liveSchema(
  source: ToolSchemaSource | undefined,
  direction: "input" | "output",
): ToolSchema | undefined {
  if (isToolSchema(source)) return source;
  if (source === undefined || !("~standard" in source)) return undefined;
  const standard = source["~standard"];
  if (
    typeof standard !== "object" ||
    standard === null ||
    !("validate" in standard) ||
    typeof standard.validate !== "function"
  )
    return undefined;

  // Zod 3 exposes validation separately from its JSON Schema adapter.
  const validator = standard as StandardSchemaV1["~standard"];
  const emitted = direction === "input" ? toInputSchema(source) : toOutputSchema(source);
  return {
    "~standard": {
      ...emitted["~standard"],
      validate: (value) => validator.validate(value),
    },
  };
}

/** Each resolution has its own identity, even when its JSON Schema matches another tool. */
export function registerDynamicToolSchemas(input: {
  readonly inputSchema: ToolSchemaSource;
  readonly outputSchema?: ToolSchemaSource;
}): DynamicToolSchemaReference | undefined {
  const schemas: LiveToolSchemas = {
    input: liveSchema(input.inputSchema, "input"),
    output: liveSchema(input.outputSchema, "output"),
  };
  if (schemas.input === undefined && schemas.output === undefined) return undefined;
  const id = randomUUID();
  const entries = registry();
  entries.set(id, schemas);
  if (entries.size > MAX_CACHED_SCHEMAS) entries.delete(entries.keys().next().value!);
  return { id, input: schemas.input !== undefined, output: schemas.output !== undefined };
}

export function hasUnavailableDynamicToolSchemas(
  metadata: readonly CurrentDynamicToolMetadata[],
): boolean {
  return metadata.some(
    (entry) => entry.runtimeSchemas !== undefined && lookup(entry.runtimeSchemas.id) === undefined,
  );
}

export function getDynamicToolSchemas(metadata: CurrentDynamicToolMetadata): LiveToolSchemas {
  if (metadata.runtimeSchemas === undefined) return {};
  const schemas = lookup(metadata.runtimeSchemas.id);
  if (schemas === undefined) {
    throw new Error(
      `Dynamic tool "${metadata.name}" cannot replay its authored schema validation because its live schemas are unavailable. Restore its resolver or start a new session.`,
    );
  }
  return {
    input: metadata.runtimeSchemas.input ? schemas.input : undefined,
    output: metadata.runtimeSchemas.output ? schemas.output : undefined,
  };
}

/** Restore validators from this entry's resolver without changing persisted callback closures. */
export function rebindDynamicToolSchemas(
  metadata: CurrentDynamicToolMetadata,
  resolved: CurrentDynamicToolMetadata | undefined,
): CurrentDynamicToolMetadata {
  if (!hasUnavailableDynamicToolSchemas([metadata])) return metadata;
  if (
    resolved?.runtimeSchemas === undefined ||
    resolved.resolverSlug !== metadata.resolverSlug ||
    resolved.entryKey !== metadata.entryKey ||
    resolved.name !== metadata.name ||
    (metadata.runtimeSchemas?.input === true && !resolved.runtimeSchemas.input) ||
    (metadata.runtimeSchemas?.output === true && !resolved.runtimeSchemas.output) ||
    lookup(resolved.runtimeSchemas.id) === undefined
  ) {
    throw new Error(
      `Dynamic tool "${metadata.name}" cannot restore its authored schema validation because its resolver did not return the same entry with live schemas.`,
    );
  }
  return {
    ...metadata,
    runtimeSchemas: { ...metadata.runtimeSchemas!, id: resolved.runtimeSchemas.id },
  };
}
