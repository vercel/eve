import { expectObjectRecord, expectOnlyKnownKeys } from "#internal/authored-module.js";
import type {
  ScheduleCollectionDefinition,
  ScheduleProvider,
} from "#public/schedules/collection.js";
import { SCHEDULE_DELIVERY_NAME_PATTERN } from "#runtime/schedules/validation.js";
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
  "request",
  "metadata",
  "deliveries",
  "auth",
  "events",
  "tools",
] as const;

const DELIVERY_KEYS = ["description", "capture", "verify", "deliver"] as const;

function normalizeDeliveries(value: unknown, message: string): void {
  if (value === undefined)
    throw new Error(
      `${message} "deliveries" is required: define at least one place schedule results can go.`,
    );
  const deliveries = expectObjectRecord(value, `${message} "deliveries" must be an object.`);
  const names = Object.keys(deliveries);
  if (names.length === 0)
    throw new Error(
      `${message} "deliveries" must define at least one delivery: a schedule cannot exist without one.`,
    );
  for (const name of names) {
    if (!SCHEDULE_DELIVERY_NAME_PATTERN.test(name))
      throw new Error(
        `${message} delivery name ${JSON.stringify(name)} must match ${SCHEDULE_DELIVERY_NAME_PATTERN}.`,
      );
    const label = `${message} "deliveries.${name}"`;
    const delivery = expectObjectRecord(deliveries[name], `${label} must be an object.`);
    expectOnlyKnownKeys(delivery, DELIVERY_KEYS, label);
    if (typeof delivery.description !== "string" || delivery.description.trim() === "")
      throw new Error(`${label} "description" must be a non-empty string.`);
    if (typeof delivery.deliver !== "function")
      throw new Error(`${label} "deliver" must be a function.`);
    for (const hook of ["capture", "verify"] as const)
      if (delivery[hook] !== undefined && typeof delivery[hook] !== "function")
        throw new Error(`${label} "${hook}" must be a function when provided.`);
  }
}

export function normalizeScheduleCollectionDefinition(
  value: unknown,
  message: string,
): ScheduleCollectionDefinition {
  if (!isScheduleCollectionDefinition(value)) throw new Error(message);
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, DEFINITION_KEYS, message);
  if (
    record.description !== undefined &&
    (typeof record.description !== "string" || record.description.trim() === "")
  )
    throw new Error(`${message} "description" must be a non-empty string when provided.`);
  for (const key of ["request", "metadata"] as const) {
    const schema = record[key];
    if (
      schema !== undefined &&
      (typeof schema !== "object" ||
        schema === null ||
        typeof Reflect.get(schema, "~standard") !== "object")
    )
      throw new Error(`${message} "${key}" must be a Standard Schema when provided.`);
  }
  if (record.scope !== undefined && typeof record.scope !== "function")
    throw new Error(`${message} "scope" must be a function when provided.`);
  if (typeof record.auth !== "function")
    throw new Error(
      `${message} "auth" is required and must be a function that resolves the schedule creator to execution auth.`,
    );
  normalizeDeliveries(record.deliveries, message);
  if (record.events !== undefined) {
    const events = expectObjectRecord(record.events, `${message} "events" must be an object.`);
    expectOnlyKnownKeys(
      events,
      ["occurrence.admitted", "occurrence.failed", "delivery.succeeded", "delivery.failed"],
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
  if (record.tools !== undefined && record.tools !== false) {
    const tools = expectObjectRecord(
      record.tools,
      `${message} "tools" must be an object or false.`,
    );
    expectOnlyKnownKeys(tools, ["approval"], `${message} "tools"`);
    if (tools.approval !== undefined) {
      const approval = expectObjectRecord(
        tools.approval,
        `${message} "tools.approval" must be an object.`,
      );
      expectOnlyKnownKeys(approval, SCHEDULE_OPERATIONS, `${message} "tools.approval"`);
      for (const [operation, policy] of Object.entries(approval)) {
        if (
          typeof policy !== "function" &&
          (typeof policy !== "object" ||
            policy === null ||
            typeof Reflect.get(policy, "request") !== "function" ||
            (Reflect.get(policy, "response") !== undefined &&
              typeof Reflect.get(policy, "response") !== "function"))
        )
          throw new Error(`${message} "tools.approval.${operation}" must be an approval policy.`);
      }
    }
  }
  return value as ScheduleCollectionDefinition;
}
