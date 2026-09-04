import type { JsonObject } from "#shared/json.js";
import type { ToolSchema, ToolSchemaSource } from "#tools/schema.js";
import { isStandardSchema, isToolSchema, toInputSchema, toOutputSchema } from "#tools/schema.js";

const REGISTRY = Symbol.for("eve:dynamic-tool-schemas");

interface DynamicToolSchemas {
  readonly input: ToolSchemaSource;
  readonly output?: ToolSchemaSource;
}

interface DynamicToolSchemaMetadata {
  readonly inputSchema: JsonObject;
  readonly inputSchemaIsLive?: true;
  readonly name: string;
  readonly outputSchema?: JsonObject;
  readonly outputSchemaIsLive?: true;
  readonly resolverSlug: string;
}

type Registry = WeakMap<object, DynamicToolSchemas>;

function getRegistry(): Registry {
  const global = globalThis as Record<symbol, Registry | undefined>;
  const existing = global[REGISTRY];
  if (existing !== undefined) return existing;

  const registry: Registry = new WeakMap();
  global[REGISTRY] = registry;
  return registry;
}

/** Keeps live validators beside the callback bindings that make metadata replayable. */
export function registerDynamicToolSchemas(input: {
  readonly inputSchema: ToolSchemaSource;
  readonly metadata: DynamicToolSchemaMetadata;
  readonly outputSchema?: ToolSchemaSource;
}): void {
  getRegistry().set(input.metadata, {
    input: input.inputSchema,
    output: input.outputSchema,
  });
}

export function clearDynamicToolSchemas(metadata: DynamicToolSchemaMetadata): void {
  getRegistry().delete(metadata);
}

/** Carries newly resolved live schemas onto metadata whose durable closures must be preserved. */
export function transferDynamicToolSchemas(
  target: readonly DynamicToolSchemaMetadata[],
  resolved: readonly DynamicToolSchemaMetadata[],
): void {
  const registry = getRegistry();
  for (const entry of target) {
    if (entry.inputSchemaIsLive !== true && entry.outputSchemaIsLive !== true) continue;
    if (registry.has(entry)) continue;
    const source = resolved.find(
      (candidate) => candidate.name === entry.name && candidate.resolverSlug === entry.resolverSlug,
    );
    if (source === undefined) continue;
    const schemas = registry.get(source);
    if (schemas !== undefined) registry.set(entry, schemas);
  }
}

export function hasUnregisteredDynamicToolSchemas(
  metadata: readonly DynamicToolSchemaMetadata[],
): boolean {
  const registry = getRegistry();
  return metadata.some(
    (entry) =>
      (entry.inputSchemaIsLive === true || entry.outputSchemaIsLive === true) &&
      !registry.has(entry),
  );
}

export function replayDynamicToolInputSchema(metadata: DynamicToolSchemaMetadata): ToolSchema {
  if (metadata.inputSchemaIsLive !== true) return toInputSchema(metadata.inputSchema);
  const registered = getRegistry().get(metadata);
  if (registered !== undefined) {
    return preserveLiveValidation(registered.input, metadata.inputSchema, "input");
  }
  throw missingLiveSchemaError(metadata.name, "input");
}

export function replayDynamicToolOutputSchema(
  metadata: DynamicToolSchemaMetadata,
): ToolSchema | undefined {
  if (metadata.outputSchemaIsLive !== true) return toOutputSchema(metadata.outputSchema);
  if (metadata.outputSchema === undefined) {
    throw missingLiveSchemaError(metadata.name, "output");
  }
  const registered = getRegistry().get(metadata);
  if (registered !== undefined) {
    if (registered.output === undefined) {
      throw missingLiveSchemaError(metadata.name, "output");
    }
    return preserveLiveValidation(registered.output, metadata.outputSchema, "output");
  }
  throw missingLiveSchemaError(metadata.name, "output");
}

function preserveLiveValidation(
  source: ToolSchemaSource,
  fallback: JsonObject,
  direction: "input" | "output",
): ToolSchema {
  if (isToolSchema(source)) return source;
  if (!isStandardSchema(source)) {
    return direction === "input" ? toInputSchema(source) : toOutputSchema(source);
  }

  const standard = source["~standard"];
  const emit = (): Record<string, unknown> => structuredClone(fallback);
  return {
    "~standard": {
      ...standard,
      vendor: "eve",
      jsonSchema: { input: emit, output: emit },
    },
  } as ToolSchema;
}

function missingLiveSchemaError(toolName: string, direction: "input" | "output"): Error {
  return new Error(
    `Dynamic tool "${toolName}" cannot replay its live ${direction} schema because its resolver ` +
      "is not registered in this process. Restore the tool definition or start a new session.",
  );
}
