import assert from "node:assert/strict";

import { parseJsonValue, type JsonValue } from "#shared/json.js";

type Awaitable<T> = T | PromiseLike<T>;

export interface FrozenDurableBoundaryFixture<TExpected = unknown> {
  readonly capture?: () => Awaitable<unknown>;
  readonly expected: TExpected;
  readonly name: string;
  readonly serialized?: string;
  readonly source: string;
}

export interface DurableBoundaryPass<TState, TObservation> {
  readonly observation: TObservation;
  readonly serialized: JsonValue;
  readonly state: TState;
}

export interface DurableBoundaryCompatibilityResult<TState, TObservation, TExpected> {
  readonly first: DurableBoundaryPass<TState, TObservation>;
  readonly fixture: FrozenDurableBoundaryFixture<TExpected>;
  readonly repeated: DurableBoundaryPass<TState, TObservation>;
  readonly rollback?: DurableBoundaryPass<TState, TObservation>;
  readonly rollbackSerialized?: JsonValue;
  readonly source: JsonValue;
}

export async function assertDurableBoundaryCompatibility<TState, TObservation, TExpected>(input: {
  readonly assert: (
    result: DurableBoundaryCompatibilityResult<TState, TObservation, TExpected>,
  ) => Awaitable<void>;
  readonly boundary: string;
  readonly fixture: FrozenDurableBoundaryFixture<TExpected>;
  readonly hydrate: (serialized: JsonValue) => Awaitable<TState>;
  readonly migrate: (state: TState) => Awaitable<TObservation>;
  readonly rollback?: {
    readonly apply: (
      original: Record<string, unknown>,
      interrupted: Record<string, unknown>,
    ) => Record<string, unknown>;
    readonly preservedKeys: readonly string[];
  };
  readonly serialize: (state: TState) => Awaitable<unknown>;
}): Promise<DurableBoundaryCompatibilityResult<TState, TObservation, TExpected>> {
  const source = await loadFixture(input.boundary, input.fixture);
  const first = await runPass(input, source);
  const repeated = await runPass(input, first.serialized);
  assert.deepStrictEqual(
    repeated.serialized,
    first.serialized,
    `${input.boundary} fixture "${input.fixture.name}" did not reach a durable fixed point`,
  );

  if (input.rollback === undefined) {
    const result = { first, fixture: input.fixture, repeated, source };
    await input.assert(result);
    return result;
  }

  const original = requireRecord(source, "fixture source");
  const interrupted = requireRecord(first.serialized, "first migrated value");
  const rollbackProbeKey = "__eveDurableBoundaryRollbackProbe";
  assert.ok(!Object.hasOwn(original, rollbackProbeKey));
  const interruptedWithProbe = { ...cloneRecord(interrupted), [rollbackProbeKey]: true };
  const rolledBack = input.rollback.apply(cloneRecord(original), interruptedWithProbe);
  assert.ok(
    !Object.hasOwn(rolledBack, rollbackProbeKey),
    `${input.boundary} fixture "${input.fixture.name}" retained discarded rollback state`,
  );
  for (const key of input.rollback.preservedKeys) {
    assert.ok(
      Object.hasOwn(interrupted, key),
      `${input.boundary} fixture "${input.fixture.name}" did not produce preserved key "${key}"`,
    );
    assert.deepStrictEqual(
      rolledBack[key],
      interrupted[key],
      `${input.boundary} fixture "${input.fixture.name}" did not preserve "${key}" during rollback`,
    );
  }
  for (const [key, value] of Object.entries(original)) {
    if (input.rollback.preservedKeys.includes(key)) continue;
    assert.deepStrictEqual(
      rolledBack[key],
      value,
      `${input.boundary} fixture "${input.fixture.name}" changed original key "${key}" during rollback`,
    );
  }
  const rollbackSerialized = jsonTransport(rolledBack);
  const rollback = await runPass(input, rollbackSerialized);
  assert.deepStrictEqual(
    rollback.serialized,
    first.serialized,
    `${input.boundary} fixture "${input.fixture.name}" changed after rollback replay`,
  );
  const result = {
    first,
    fixture: input.fixture,
    repeated,
    rollback,
    rollbackSerialized,
    source,
  };
  await input.assert(result);
  return result;
}

async function runPass<TState, TObservation, TExpected>(
  input: {
    readonly fixture: FrozenDurableBoundaryFixture<TExpected>;
    readonly hydrate: (serialized: JsonValue) => Awaitable<TState>;
    readonly migrate: (state: TState) => Awaitable<TObservation>;
    readonly serialize: (state: TState) => Awaitable<unknown>;
  },
  serialized: JsonValue,
): Promise<DurableBoundaryPass<TState, TObservation>> {
  const state = await input.hydrate(jsonTransport(serialized));
  const observation = await input.migrate(state);
  return {
    observation,
    serialized: jsonTransport(await input.serialize(state)),
    state,
  };
}

async function loadFixture(
  boundary: string,
  fixture: FrozenDurableBoundaryFixture,
): Promise<JsonValue> {
  if (fixture.capture === undefined && fixture.serialized === undefined) {
    throw new Error(`${boundary} fixture "${fixture.name}" has no capture or frozen JSON`);
  }
  const captured =
    fixture.capture === undefined ? undefined : jsonTransport(await fixture.capture());
  if (fixture.serialized === undefined) return captured!;
  let frozen: JsonValue;
  try {
    frozen = parseJsonValue(JSON.parse(fixture.serialized) as unknown);
  } catch (error) {
    throw new Error(`Invalid frozen JSON for "${fixture.name}" from ${fixture.source}`, {
      cause: error,
    });
  }
  if (captured !== undefined) {
    assert.deepStrictEqual(
      captured,
      frozen,
      `${boundary} fixture "${fixture.name}" no longer matches its historical producer`,
    );
  }
  return frozen;
}

function jsonTransport(value: unknown): JsonValue {
  const strict = parseJsonValue(value);
  const serialized = JSON.stringify(strict);
  if (serialized === undefined)
    throw new TypeError("Durable boundary value is not JSON-serializable");
  return parseJsonValue(JSON.parse(serialized) as unknown);
}

function requireRecord(value: JsonValue, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return requireRecord(jsonTransport(value), "cloned durable value");
}
