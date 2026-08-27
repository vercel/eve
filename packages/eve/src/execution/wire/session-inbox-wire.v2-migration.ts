import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";
import { isObject } from "#shared/guards.js";

export const sessionInboxWireV1Migration: VersionMigration = {
  from: 1,
  migrate(prior) {
    const normalized = normalizeSessionInboxWireV2(prior) as Record<string, unknown>;
    return {
      ...normalized,
      ...(normalized.kind === "deliver" && !("payload" in normalized) ? { payload: {} } : {}),
      version: 2,
    };
  },
  to: 2,
};

/** Converts Workflow-VM records into this realm before wire consumption. */
export function normalizeSessionInboxWireV2(value: unknown, arrayFallback = false): unknown {
  if (value === undefined) return arrayFallback ? null : undefined;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSessionInboxWireV2(item, true));
  }
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .map(([key, item]) => [key, normalizeSessionInboxWireV2(item)]),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === null ||
    prototype === Object.prototype ||
    Object.getPrototypeOf(prototype) === null
  );
}
