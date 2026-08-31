import { describe, expect, it } from "vitest";

import { assertDurableBoundaryCompatibility } from "#internal/testing/durable-boundary-compatibility.js";

describe("assertDurableBoundaryCompatibility", () => {
  it("replays a historical fixture to a durable fixed point", async () => {
    const result = await assertDurableBoundaryCompatibility({
      assert: () => undefined,
      boundary: "test counter",
      fixture: {
        capture: () => ({ counter: 0 }),
        expected: 1,
        name: "unversioned counter",
        source: "test@v0",
      },
      hydrate: (serialized) => serialized as { counter: number },
      exercise: (state) => {
        if (state.counter === 0) state.counter = 1;
        return state.counter;
      },
      serialize: (state) => state,
    });

    expect(result.first.observation).toBe(1);
    expect(result.repeated.observation).toBe(1);
    expect(result.first.serialized).toEqual({ counter: 1 });
  });

  it("replays rollback and requires preserved keys to exist", async () => {
    const result = await assertDurableBoundaryCompatibility({
      assert: () => undefined,
      boundary: "test rollback",
      fixture: {
        expected: true,
        name: "legacy state",
        serialized: '{"unrelated":"original"}',
        source: "test@v0",
      },
      hydrate: (serialized) => serialized as Record<string, unknown>,
      exercise: (state) => {
        state.retained = { version: 1 };
        return true;
      },
      rollback: {
        apply: (original, interrupted) => ({ ...original, retained: interrupted.retained }),
        preservedKeys: ["retained"],
      },
      serialize: (state) => state,
    });

    expect(result.rollbackSerialized).toEqual({
      retained: { version: 1 },
      unrelated: "original",
    });
    expect(result.rollback?.serialized).toEqual(result.first.serialized);
  });

  it("rejects vacuous rollback assertions", async () => {
    await expect(
      assertDurableBoundaryCompatibility({
        assert: () => undefined,
        boundary: "test rollback",
        fixture: {
          expected: true,
          name: "missing key",
          serialized: "{}",
          source: "test@v0",
        },
        hydrate: (serialized) => serialized as Record<string, unknown>,
        exercise: () => true,
        rollback: {
          apply: (original) => original,
          preservedKeys: ["retained"],
        },
        serialize: (state) => state,
      }),
    ).rejects.toThrow('did not produce preserved key "retained"');
  });

  it("rejects undeclared rollback state", async () => {
    await expect(
      assertDurableBoundaryCompatibility({
        assert: () => undefined,
        boundary: "test rollback",
        exercise: (state: Record<string, unknown>) => {
          state.retained = true;
          state.leaked = true;
          return true;
        },
        fixture: {
          expected: true,
          name: "leaked key",
          serialized: "{}",
          source: "test@v0",
        },
        hydrate: (serialized) => serialized as Record<string, unknown>,
        rollback: {
          apply: (original, interrupted) => ({
            ...original,
            leaked: interrupted.leaked,
            retained: interrupted.retained,
          }),
          preservedKeys: ["retained"],
        },
        serialize: (state) => state,
      }),
    ).rejects.toThrow('retained undeclared rollback key "leaked"');
  });

  it("rejects drift between an executable producer and frozen JSON", async () => {
    await expect(
      assertDurableBoundaryCompatibility({
        assert: () => undefined,
        boundary: "test capture",
        fixture: {
          capture: () => ({ version: 2 }),
          expected: true,
          name: "captured value",
          serialized: '{"version":1}',
          source: "test@v1",
        },
        hydrate: (serialized) => serialized,
        exercise: () => true,
        serialize: (state) => state,
      }),
    ).rejects.toThrow("no longer matches its historical producer");
  });

  it("rejects lossy values before JSON transport can coerce them", async () => {
    await expect(
      assertDurableBoundaryCompatibility({
        assert: () => undefined,
        boundary: "test capture",
        fixture: {
          capture: () => ({ capturedAt: new Date("2026-01-01T00:00:00.000Z") }),
          expected: true,
          name: "lossy capture",
          source: "test@v0",
        },
        hydrate: (serialized) => serialized,
        exercise: () => true,
        serialize: (state) => state,
      }),
    ).rejects.toThrow("Expected a JSON-serializable value");
  });
});
