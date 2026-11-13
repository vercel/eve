import {
  expectAgentToolExposure,
  expectObjectRecord,
  expectOnlyKnownKeys,
} from "#internal/authored-module.js";
import type {
  DynamicSchedulesDefinition,
  ScheduleProvider,
} from "#public/schedules/subscription.js";
import { isScheduleCollectionDefinition } from "#shared/schedule-collection-definition.js";

const SCHEDULE_OPERATIONS = [
  "create",
  "get",
  "list",
  "update",
  "enable",
  "disable",
  "invoke",
  "delete",
] as const;

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
const DEFINITION_KEYS = [
  "id",
  "description",
  "provider",
  "scope",
  "inputSchema",
  "preparePayload",
  "run",
  "auth",
  "events",
  "tool",
  "scopes",
  "approval",
] as const;

// A path-derived name joins file segments with "/"; the rest is what a tool name accepts.
const SCHEDULE_COLLECTION_ID_PATTERN = /^(?=.{1,64}$)[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u;

const SCHEDULE_SCOPE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u;

export function normalizeScheduleCollectionDefinition(
  value: unknown,
  message: string,
): DynamicSchedulesDefinition {
  if (!isScheduleCollectionDefinition(value)) throw new Error(message);
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, DEFINITION_KEYS, message);
  if (
    record.id !== undefined &&
    (typeof record.id !== "string" || !SCHEDULE_COLLECTION_ID_PATTERN.test(record.id))
  )
    throw new Error(
      `${message} "id" must be 1 to 64 ASCII letters, digits, underscores, and dashes, with "/" only between segments.`,
    );
  if (
    record.description !== undefined &&
    (typeof record.description !== "string" || record.description.trim() === "")
  )
    throw new Error(`${message} "description" must be a non-empty string when provided.`);
  const schema = expectObjectRecord(
    record.inputSchema,
    `${message} "inputSchema" is required and must be a Standard Schema.`,
  );
  const standard = expectObjectRecord(
    schema["~standard"],
    `${message} "inputSchema" must be a Standard Schema.`,
  );
  if (typeof standard.validate !== "function")
    throw new Error(`${message} "inputSchema" must supply a Standard Schema validate function.`);
  if (record.preparePayload !== undefined && typeof record.preparePayload !== "function")
    throw new Error(`${message} "preparePayload" must be a function when provided.`);
  if (typeof record.run !== "function")
    throw new Error(`${message} "run" is required and must be a function.`);
  if (record.scope !== undefined && typeof record.scope !== "function")
    throw new Error(`${message} "scope" must be a function when provided.`);
  if (typeof record.auth !== "function")
    throw new Error(
      `${message} "auth" is required and must be a function that resolves the schedule creator to execution auth.`,
    );
  if (record.events !== undefined) {
    const events = expectObjectRecord(record.events, `${message} "events" must be an object.`);
    expectOnlyKnownKeys(
      events,
      ["occurrence.dispatched", "occurrence.failed"],
      `${message} "events"`,
    );
    for (const [name, handler] of Object.entries(events))
      if (handler !== undefined && typeof handler !== "function")
        throw new Error(`${message} "events.${name}" must be a function.`);
  }
  const provider = expectObjectRecord(record.provider, `${message} "provider" must be an object.`);
  expectOnlyKnownKeys(provider, PROVIDER_KEYS, `${message} "provider"`);
  if (typeof provider.kind !== "string" || provider.kind.trim() === "")
    throw new Error(`${message} provider.kind must be a non-empty string.`);
  for (const method of PROVIDER_METHODS)
    if (typeof provider[method] !== "function")
      throw new Error(`${message} provider.${method} must be a function.`);
  if (record.tool !== undefined) expectAgentToolExposure(record.tool, message);
  if (record.scopes !== undefined) {
    if (record.scope !== undefined)
      throw new Error(`${message} Set "scope" or "scopes", not both.`);
    const scopes = expectObjectRecord(record.scopes, `${message} "scopes" must be an object.`);
    if (Object.keys(scopes).length === 0)
      throw new Error(`${message} "scopes" must declare at least one scope.`);
    for (const [name, entry] of Object.entries(scopes)) {
      const at = `${message} "scopes.${name}"`;
      if (!SCHEDULE_SCOPE_NAME_PATTERN.test(name))
        throw new Error(
          `${at} must be named with 1 to 64 ASCII letters, digits, underscores, and dashes.`,
        );
      if (typeof entry === "function") continue;
      const scope = expectObjectRecord(
        entry,
        `${at} must be a scope resolver function or an object with "resolve".`,
      );
      expectOnlyKnownKeys(
        scope,
        ["description", "id", "resolve", "preparePayload", "run", "approval"],
        at,
      );
      if (typeof scope.resolve !== "function")
        throw new Error(`${at} "resolve" is required and must be a function.`);
      for (const key of ["preparePayload", "run"] as const)
        if (scope[key] !== undefined && typeof scope[key] !== "function")
          throw new Error(`${at} "${key}" must be a function when provided.`);
      if (
        scope.description !== undefined &&
        (typeof scope.description !== "string" || scope.description.trim() === "")
      )
        throw new Error(`${at} "description" must be a non-empty string when provided.`);
      if (
        scope.id !== undefined &&
        (typeof scope.id !== "string" || !SCHEDULE_COLLECTION_ID_PATTERN.test(scope.id))
      )
        throw new Error(
          `${at} "id" must be 1 to 64 ASCII letters, digits, underscores, and dashes, with "/" only between segments.`,
        );
      if (scope.approval !== undefined) {
        if (record.tool === false)
          throw new Error(
            `${message} "scopes.${name}.approval" cannot be configured when tool is false.`,
          );
        expectApprovals(scope.approval, message, `scopes.${name}.approval`);
      }
    }
  }
  if (record.tool === false && record.approval !== undefined)
    throw new Error(`${message} "approval" cannot be configured when tool is false.`);
  if (record.approval !== undefined) expectApprovals(record.approval, message, "approval");
  return value as DynamicSchedulesDefinition;
}

function expectApprovals(value: unknown, message: string, path: string): void {
  const approval = expectObjectRecord(value, `${message} "${path}" must be an object.`);
  expectOnlyKnownKeys(approval, SCHEDULE_OPERATIONS, `${message} "${path}"`);
  for (const [operation, policy] of Object.entries(approval)) {
    if (
      typeof policy !== "function" &&
      (typeof policy !== "object" ||
        policy === null ||
        typeof Reflect.get(policy, "request") !== "function" ||
        (Reflect.get(policy, "response") !== undefined &&
          typeof Reflect.get(policy, "response") !== "function"))
    )
      throw new Error(`${message} "${path}.${operation}" must be an approval policy.`);
  }
}
