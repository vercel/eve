import type { ModuleDefinitionExport } from "#public/definitions/source.js";
import type { JsonObject } from "#shared/json.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { AgentModelOptionsDefinition } from "#shared/agent-definition.js";

/**
 * Returns the selected authored module export from one namespace.
 */
export function getAuthoredModuleExport(
  moduleNamespace: Record<string, unknown>,
  source: ModuleSourceRef | { readonly exportName?: string; readonly logicalPath: string },
): unknown {
  return moduleNamespace[source.exportName ?? "default"];
}

/**
 * Materializes one authored module export that may be a definition factory.
 */
export async function materializeAuthoredModuleExport<TDefinition>(
  exportValue: ModuleDefinitionExport<TDefinition>,
): Promise<TDefinition> {
  if (typeof exportValue === "function") {
    const definitionFactory = exportValue as () => TDefinition | Promise<TDefinition>;
    return await definitionFactory();
  }

  return exportValue;
}

/**
 * Returns the value as a plain object or throws.
 */
export function expectObjectRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

/**
 * Returns the value as a string or throws.
 */
export function expectString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }

  return value;
}

/**
 * Returns the value as a boolean or throws.
 */
export function expectBoolean(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(message);
  }

  return value;
}

/**
 * Returns the value as a function or throws.
 */
export function expectFunction<TFunction extends (...args: never[]) => unknown>(
  value: unknown,
  message: string,
): TFunction {
  if (typeof value !== "function") {
    throw new Error(message);
  }

  return value as TFunction;
}

/**
 * Returns the value as a provider options object or throws.
 */
export function expectProviderOptions(
  value: unknown,
  message: string,
): Required<AgentModelOptionsDefinition>["providerOptions"] {
  const record = expectObjectRecord(value, message);
  const providerOptions: Required<AgentModelOptionsDefinition>["providerOptions"] = {};
  for (const [key, entryValue] of Object.entries(record)) {
    const entryRecord = expectObjectRecord(entryValue, message);
    providerOptions[key] = entryRecord as JsonObject;
  }
  return providerOptions;
}

/**
 * Rejects unexpected keys on one plain object.
 */
export function expectOnlyKnownKeys(
  record: Record<string, unknown>,
  knownKeys: readonly string[],
  message: string,
): void {
  const knownKeySet = new Set(knownKeys);

  for (const key of Object.keys(record)) {
    if (!knownKeySet.has(key)) {
      throw new Error(`${message} Unknown key "${key}".`);
    }
  }
}

/**
 * Returns one optional string-record property when present.
 */
export function getOptionalStringRecordProperty(
  record: Record<string, unknown>,
  key: string,
  message: string,
): Record<string, string> | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  const objectValue = expectObjectRecord(value, message);
  const normalizedValue: Record<string, string> = {};

  for (const [entryKey, entryValue] of Object.entries(objectValue)) {
    normalizedValue[entryKey] = expectString(entryValue, message);
  }

  return normalizedValue;
}
