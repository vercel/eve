import { expectObjectRecord, expectOnlyKnownKeys } from "#internal/authored-module.js";
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
  "description",
  "provider",
  "scope",
  "inputSchema",
  "preparePayload",
  "run",
  "auth",
  "events",
  "tool",
  "approval",
] as const;

export function normalizeScheduleCollectionDefinition(
  value: unknown,
  message: string,
): DynamicSchedulesDefinition {
  if (!isScheduleCollectionDefinition(value)) throw new Error(message);
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, DEFINITION_KEYS, message);
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
  if (record.tool !== undefined && typeof record.tool !== "boolean")
    throw new Error(
      `${message} "tool" must be true or false; deferred tools are not supported yet.`,
    );
  if (record.tool === false && record.approval !== undefined)
    throw new Error(`${message} "approval" cannot be configured when tool is false.`);
  if (record.approval !== undefined) {
    const approval = expectObjectRecord(
      record.approval,
      `${message} "approval" must be an object.`,
    );
    expectOnlyKnownKeys(approval, SCHEDULE_OPERATIONS, `${message} "approval"`);
    for (const [operation, policy] of Object.entries(approval)) {
      if (
        typeof policy !== "function" &&
        (typeof policy !== "object" ||
          policy === null ||
          typeof Reflect.get(policy, "request") !== "function" ||
          (Reflect.get(policy, "response") !== undefined &&
            typeof Reflect.get(policy, "response") !== "function"))
      )
        throw new Error(`${message} "approval.${operation}" must be an approval policy.`);
    }
  }
  return value as DynamicSchedulesDefinition;
}
