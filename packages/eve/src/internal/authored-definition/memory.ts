import type { MemoryDefinition } from "#public/memory/index.js";
import { expectObjectRecord, expectOnlyKnownKeys } from "#internal/authored-module.js";
import { isMemoryDefinition } from "#shared/memory-definition.js";

export function normalizeMemoryDefinition(value: unknown, message: string): MemoryDefinition {
  if (!isMemoryDefinition(value)) throw new Error(message);
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(
    record,
    ["description", "namespace", "provider", "scope", "tools", "visibility"],
    message,
  );
  if (
    record.description !== undefined &&
    (typeof record.description !== "string" || record.description.trim().length === 0)
  ) {
    throw new Error(`${message} "description" must be a non-empty string when provided.`);
  }
  if (
    record.namespace !== undefined &&
    record.namespace !== null &&
    typeof record.namespace !== "string" &&
    typeof record.namespace !== "function"
  ) {
    throw new Error(`${message} "namespace" must be a string, null, or resolver.`);
  }
  if (
    record.scope !== null &&
    typeof record.scope !== "string" &&
    typeof record.scope !== "function"
  ) {
    throw new Error(`${message} "scope" must be a string, null, or resolver.`);
  }
  const provider = expectObjectRecord(record.provider, `${message} "provider" must be an object.`);
  if (typeof provider.recall !== "function") {
    throw new Error(`${message} "provider.recall" must be a function.`);
  }
  if (provider.capture !== undefined && typeof provider.capture !== "function") {
    throw new Error(`${message} "provider.capture" must be a function when provided.`);
  }
  if (provider.tools !== undefined && typeof provider.tools !== "function") {
    throw new Error(`${message} "provider.tools" must be a function when provided.`);
  }
  if (record.tools !== undefined && record.tools !== false) {
    throw new Error(`${message} "tools" may only be false when provided.`);
  }
  if (
    record.visibility !== undefined &&
    !["scope", "session"].includes(String(record.visibility))
  ) {
    throw new Error(`${message} "visibility" must be "scope" or "session".`);
  }
  return value as MemoryDefinition;
}
