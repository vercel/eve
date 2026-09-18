import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  hydrateStepArguments,
  hydrateStepReturnValue,
} from "#compiled/@workflow/core/serialization.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import {
  applyTurnStepDelta,
  captureTurnStepState,
  createTurnStepDelta,
  type DurableStepDelta,
} from "./turn-step-delta.js";
import type { DurableStepResult, TurnStepState } from "./turn-step-types.js";

interface FuzzState {
  entries: Record<string, fc.JsonValue>;
  items: fc.JsonValue[];
}

type Mutation =
  | { kind: "set"; key: string; value: fc.JsonValue }
  | { kind: "delete" | "reinsert"; index: number }
  | { kind: "reverse" }
  | { kind: "append"; value: fc.JsonValue }
  | { kind: "truncate"; length: number }
  | { kind: "edit"; index: number; value: fc.JsonValue };

const runId = "wrun_state_delta_fuzz";
// Bound keys to six characters: Workflow rejects own __proto__ properties before delta creation.
const key = fc.string({ minLength: 1, maxLength: 6 });
function jsonValue(depth: number): fc.Arbitrary<fc.JsonValue> {
  const scalar = fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.string({ maxLength: 20 }),
  );
  if (depth === 0) return scalar;
  const child = jsonValue(depth - 1);
  return fc.oneof(
    scalar,
    fc.array(child, { maxLength: 3 }),
    fc.dictionary(key, child, { maxKeys: 3, noNullPrototype: true }),
  );
}
const value = jsonValue(2);
const initialState = fc.record({
  entries: fc.dictionary(key, value, { maxKeys: 5, noNullPrototype: true }),
  items: fc.array(value, { maxLength: 5 }),
});
const mutation: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ kind: fc.constant("set"), key, value }),
  fc.record({ kind: fc.constant("delete"), index: fc.nat({ max: 10 }) }),
  fc.record({ kind: fc.constant("reinsert"), index: fc.nat({ max: 10 }) }),
  fc.constant({ kind: "reverse" }),
  fc.record({ kind: fc.constant("append"), value }),
  fc.record({ kind: fc.constant("truncate"), length: fc.nat({ max: 10 }) }),
  fc.record({ kind: fc.constant("edit"), index: fc.nat({ max: 10 }), value }),
);

function mutate(state: FuzzState, operation: Mutation): void {
  switch (operation.kind) {
    case "set":
      Object.defineProperty(state.entries, operation.key, {
        value: operation.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      break;
    case "delete":
    case "reinsert": {
      const keys = Object.keys(state.entries);
      if (keys.length === 0) break;
      const name = keys[operation.index % keys.length]!;
      const previous = state.entries[name]!;
      delete state.entries[name];
      if (operation.kind === "reinsert") mutate(state, { kind: "set", key: name, value: previous });
      break;
    }
    case "reverse":
      state.entries = Object.fromEntries(Object.entries(state.entries).reverse());
      break;
    case "append":
      state.items.push(operation.value);
      break;
    case "truncate":
      state.items.length = Math.min(state.items.length, operation.length);
      break;
    case "edit":
      if (state.items.length > 0)
        state.items[operation.index % state.items.length] = operation.value;
      break;
  }
}

// Tree-only comparison: ordered own keys distinguish reordering, holes, and missing properties.
function assertSameState(actual: unknown, expected: unknown): void {
  if (expected === null || typeof expected !== "object") {
    expect(actual).toBe(expected);
    return;
  }
  expect(actual).not.toBeNull();
  expect(typeof actual).toBe("object");
  expect(Array.isArray(actual)).toBe(Array.isArray(expected));
  if (Array.isArray(expected)) expect((actual as unknown[]).length).toBe(expected.length);
  expect(Object.keys(actual as object)).toEqual(Object.keys(expected));
  for (const name of Object.keys(expected))
    assertSameState(Reflect.get(actual as object, name), Reflect.get(expected, name));
}

async function roundTripOutput<T>(result: T): Promise<T> {
  const encoded = await dehydrateStepReturnValue(
    result,
    runId,
    undefined,
    [],
    globalThis,
    false,
    false,
    false,
  );
  return await hydrateStepReturnValue(encoded, runId, undefined);
}

async function roundTripInput(state: TurnStepState): Promise<TurnStepState> {
  const encoded = await dehydrateStepArguments({ args: [state] }, runId, undefined);
  const { args } = await hydrateStepArguments(encoded, runId, undefined);
  return args[0];
}

async function checkSequence(initial: FuzzState, operations: readonly Mutation[]): Promise<void> {
  const start = await roundTripInput({
    serializedContext: { fuzz: initial },
    sessionState: createTestSessionState(),
  });
  let checkpoint = start;
  const recorded: { delta: DurableStepDelta; expected: DurableStepResult }[] = [];
  for (const operation of operations) {
    const untouched = await roundTripInput(checkpoint);
    const attempt = await roundTripInput(checkpoint);
    const captured = captureTurnStepState(attempt);
    // Never mutate fast-check's generated values; shrinking must see the original inputs.
    mutate(attempt.serializedContext.fuzz as FuzzState, structuredClone(operation));
    const result: DurableStepResult = { action: "continue", ...attempt };
    const expected = await roundTripOutput(result);
    const delta = await roundTripOutput(createTurnStepDelta(captured, result));
    const actual = applyTurnStepDelta(checkpoint, delta);
    assertSameState(actual, expected);
    assertSameState(checkpoint, untouched);
    recorded.push({ delta, expected });
    checkpoint = actual;
  }

  let replay = await roundTripInput(start);
  for (const { delta, expected } of recorded) {
    replay = applyTurnStepDelta(replay, await roundTripOutput(delta));
    assertSameState(replay, expected);
  }
}

function fuzzParameters() {
  return {
    numRuns: Number(process.env.EVE_FUZZ_RUNS ?? 200),
    seed: Number(process.env.EVE_FUZZ_SEED ?? 3507),
    path: process.env.EVE_FUZZ_PATH,
  };
}

describe("turn step delta differential fuzzing", () => {
  it.each([
    [
      { a: 1, b: 2 },
      { b: 2, a: 1 },
    ],
    [{}, { value: undefined }],
    [Object.assign([], { 1: 1 }), [undefined, 1]],
    [[1], { 0: 1 }],
  ])("rejects observably different states %#", (actual, expected) => {
    expect(() => assertSameState(actual, expected)).toThrow();
  });

  it("preserves generated append sequences and replays every checkpoint", async () => {
    await fc.assert(
      fc.asyncProperty(
        initialState,
        fc.array(value, { maxLength: 12 }),
        async (initial, values) => {
          await checkSequence(
            initial,
            values.map((item) => ({ kind: "append", value: item })),
          );
        },
      ),
      fuzzParameters(),
    );
  });

  it("matches full-result serialization after generated mutations", async () => {
    await fc.assert(
      fc.asyncProperty(
        initialState,
        fc.array(mutation, { minLength: 1, maxLength: 12 }),
        checkSequence,
      ),
      fuzzParameters(),
    );
  });
});
