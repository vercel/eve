import type { ModuleDefinitionExport } from "#public/definitions/source.js";
import type { JsonObject } from "#shared/json.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { AgentModelOptionsDefinition, AgentToolExposure } from "#shared/agent-definition.js";

export function interopAuthoredModuleNamespace(namespace: unknown): unknown {
  if (typeof namespace !== "object" || namespace === null) return namespace;
  const exports: unknown = Reflect.get(namespace, "default");
  return typeof exports === "object" &&
    exports !== null &&
    Reflect.get(exports, "__esModule") === true
    ? exports
    : namespace;
}

export function getAuthoredModuleExport(
  moduleNamespace: Record<string, unknown>,
  source: ModuleSourceRef | { readonly exportName?: string; readonly logicalPath: string },
): unknown {
  return moduleNamespace[source.exportName ?? "default"];
}

export async function materializeAuthoredModuleExport<TDefinition>(
  exportValue: ModuleDefinitionExport<TDefinition>,
): Promise<TDefinition> {
  if (typeof exportValue === "function") {
    const definitionFactory = exportValue as () => TDefinition | Promise<TDefinition>;
    return await definitionFactory();
  }

  return exportValue;
}

export function expectObjectRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

export function expectString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }

  return value;
}

export function expectBoolean(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(message);
  }

  return value;
}

export function expectAgentToolExposure(value: unknown, message: string): AgentToolExposure {
  if (value === "deferred") return value;
  return expectBoolean(value, `${message} Expected "tool" to be true, false, or "deferred".`);
}

export function expectPositiveInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(message);
  }

  return value;
}

export function expectNonNegativeInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(message);
  }

  return value;
}

export function expectFunction<TFunction extends (...args: never[]) => unknown>(
  value: unknown,
  message: string,
): TFunction {
  if (typeof value !== "function") {
    throw new Error(message);
  }

  return value as TFunction;
}

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
