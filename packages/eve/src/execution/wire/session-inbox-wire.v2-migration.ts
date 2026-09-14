import { isObject } from "#shared/guards.js";

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
