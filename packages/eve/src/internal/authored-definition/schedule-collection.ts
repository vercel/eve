import { expectObjectRecord, expectOnlyKnownKeys } from "#internal/authored-module.js";
import type {
  ScheduleCollectionDefinition,
  ScheduleProvider,
} from "#public/schedules/collection.js";
import { isScheduleCollectionDefinition } from "#shared/schedule-collection-definition.js";

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

export function normalizeScheduleCollectionDefinition(
  value: unknown,
  message: string,
): ScheduleCollectionDefinition {
  if (!isScheduleCollectionDefinition(value)) throw new Error(message);
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, ["description", "provider", "runAs", "scope", "tools"], message);

  if (
    record.description !== undefined &&
    (typeof record.description !== "string" || record.description.trim().length === 0)
  ) {
    throw new Error(`${message} "description" must be a non-empty string when provided.`);
  }
  if (
    record.scope !== null &&
    typeof record.scope !== "string" &&
    typeof record.scope !== "function"
  ) {
    throw new Error(`${message} "scope" must be a string, null, or resolver.`);
  }
  if (record.runAs !== "creator" && record.runAs !== "app") {
    throw new Error(`${message} "runAs" must be "creator" or "app".`);
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
    throw new Error(`${message} "tools" must be a boolean when provided.`);
  }

  return value as ScheduleCollectionDefinition;
}
