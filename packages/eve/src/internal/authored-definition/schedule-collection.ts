import { expectObjectRecord, expectOnlyKnownKeys } from "#internal/authored-module.js";
import type {
  ScheduleCollectionDefinition,
  ScheduleCollectionToolOptions,
  ScheduleProvider,
} from "#public/schedules/collection.js";
import { isScheduleCollectionDefinition } from "#shared/schedule-collection-definition.js";
import { hasSchemaValidator } from "#tools/durable-schema.js";

const PROVIDER_KEYS = [
  "kind",
  "create",
  "list",
  "get",
  "update",
  "enable",
  "disable",
  "invoke",
  "delete",
] as const satisfies readonly (keyof ScheduleProvider)[];

const PROVIDER_METHODS = PROVIDER_KEYS.filter(
  (key): key is Exclude<(typeof PROVIDER_KEYS)[number], "kind"> => key !== "kind",
);

const TOOL_OPTIONS = [
  "create",
  "read",
  "update",
  "delete",
  "invoke",
] as const satisfies readonly (keyof ScheduleCollectionToolOptions)[];

export function normalizeScheduleCollectionDefinition(
  value: unknown,
  message: string,
): ScheduleCollectionDefinition {
  if (!isScheduleCollectionDefinition(value)) throw new Error(message);
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(
    record,
    ["description", "inputSchema", "provider", "scope", "resolveInput", "tools", "run"],
    message,
  );

  if (
    record.description !== undefined &&
    (typeof record.description !== "string" || record.description.trim().length === 0)
  ) {
    throw new Error(`${message} "description" must be a non-empty string when provided.`);
  }
  if (!hasSchemaValidator(record.inputSchema)) {
    throw new Error(`${message} "inputSchema" must implement Standard Schema validation.`);
  }
  if (
    record.scope !== null &&
    typeof record.scope !== "string" &&
    typeof record.scope !== "function"
  ) {
    throw new Error(`${message} "scope" must be a string, null, or resolver.`);
  }
  if (record.resolveInput !== undefined && typeof record.resolveInput !== "function") {
    throw new Error(`${message} "resolveInput" must be a function when provided.`);
  }
  if (typeof record.run !== "function") {
    throw new Error(`${message} "run" must be a function.`);
  }

  const provider = expectObjectRecord(record.provider, `${message} "provider" must be an object.`);
  expectOnlyKnownKeys(provider, PROVIDER_KEYS, `${message} "provider"`);
  if (typeof provider.kind !== "string" || provider.kind.trim().length === 0) {
    throw new Error(`${message} provider.kind must be a non-empty string.`);
  }
  for (const method of PROVIDER_METHODS) {
    if (typeof provider[method] !== "function") {
      throw new Error(`${message} provider.${method} must be a function.`);
    }
  }

  if (record.tools !== undefined && typeof record.tools !== "boolean") {
    const tools = expectObjectRecord(
      record.tools,
      `${message} "tools" must be a boolean or options object.`,
    );
    expectOnlyKnownKeys(tools, TOOL_OPTIONS, `${message} "tools"`);
    for (const option of TOOL_OPTIONS) {
      if (tools[option] !== undefined && typeof tools[option] !== "boolean") {
        throw new Error(`${message} tools.${option} must be a boolean when provided.`);
      }
    }
  }

  return value as ScheduleCollectionDefinition;
}
