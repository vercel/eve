import { ComputeError } from "#compute/errors.js";
import type {
  CellDefinition,
  EffectDefinition,
  RetryPolicy,
  ValueSchema,
} from "#compute/protocol.js";

const MAX_POSTGRES_INTEGER = 2_147_483_647;
const MAX_EFFECT_TIMEOUT_MS = 15 * 60 * 1_000;

function invalid(message: string): never {
  throw new ComputeError("INVALID_INPUT", message);
}

function assertDefinitionObject(value: unknown, label: string): asserts value is object {
  if (value === null || typeof value !== "object") {
    invalid(`${label} must be an object.`);
  }
}

function assertFunction(
  value: unknown,
  label: string,
): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function") {
    invalid(`${label} must be a function.`);
  }
}

function assertVersion(value: unknown, label: string): asserts value is number {
  if (
    !Number.isInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > MAX_POSTGRES_INTEGER
  ) {
    invalid(`${label} must be an integer between 1 and ${MAX_POSTGRES_INTEGER}.`);
  }
}

function assertSchema(value: unknown, label: string): asserts value is ValueSchema<unknown> {
  assertDefinitionObject(value, label);
  assertFunction((value as { parse?: unknown }).parse, `${label}.parse`);
}

function assertRetryPolicy(value: unknown): asserts value is RetryPolicy {
  assertDefinitionObject(value, "defineEffect retry");
  const retry = value as { maxAttempts?: unknown; mode?: unknown; timeoutMs?: unknown };

  if (
    !Number.isInteger(retry.timeoutMs) ||
    (retry.timeoutMs as number) <= 0 ||
    (retry.timeoutMs as number) > MAX_EFFECT_TIMEOUT_MS
  ) {
    invalid(
      `defineEffect retry.timeoutMs must be an integer between 1 and ${MAX_EFFECT_TIMEOUT_MS}.`,
    );
  }

  if (retry.mode === "manual") {
    return;
  }

  if (
    retry.mode !== "idempotent" ||
    !Number.isInteger(retry.maxAttempts) ||
    (retry.maxAttempts as number) < 1 ||
    (retry.maxAttempts as number) > 5
  ) {
    invalid('defineEffect retry must use mode "manual" or "idempotent" with 1 to 5 attempts.');
  }
}

/** Validates and returns an authored keyed-cell definition. */
export function defineCell<S, M>(definition: CellDefinition<S, M>): CellDefinition<S, M> {
  assertDefinitionObject(definition, "defineCell definition");
  assertVersion(definition.stateVersion, "defineCell stateVersion");
  assertVersion(definition.messageVersion, "defineCell messageVersion");
  assertSchema(definition.stateSchema, "defineCell stateSchema");
  assertSchema(definition.messageSchema, "defineCell messageSchema");
  assertFunction(definition.initial, "defineCell initial");
  assertFunction(definition.receive, "defineCell receive");
  assertFunction(definition.migrateState, "defineCell migrateState");
  assertFunction(definition.migrateMessage, "defineCell migrateMessage");
  return definition;
}

/** Validates and returns an authored asynchronous effect definition. */
export function defineEffect<I, O>(definition: EffectDefinition<I, O>): EffectDefinition<I, O> {
  assertDefinitionObject(definition, "defineEffect definition");
  assertVersion(definition.inputVersion, "defineEffect inputVersion");
  assertVersion(definition.outputVersion, "defineEffect outputVersion");
  assertSchema(definition.inputSchema, "defineEffect inputSchema");
  assertSchema(definition.outputSchema, "defineEffect outputSchema");
  assertRetryPolicy(definition.retry);
  assertFunction(definition.execute, "defineEffect execute");
  assertFunction(definition.migrateOutput, "defineEffect migrateOutput");
  return definition;
}
