import { describe, expect, it } from "vitest";

import { assertDurableBoundaryCompatibility } from "#internal/testing/durable-boundary-compatibility.js";

describe("assertDurableBoundaryCompatibility", () => {
  it("replays a frozen fixture to a durable fixed point", async () => {
    const result = await assertDurableBoundaryCompatibility({
      boundary: "test counter",
      fixture: {
        capture: () => ({ counter: 0 }),
        expected: 1,
        name: "unversioned counter",
        source: "test@v0",
      },
      hydrate: (serialized) => serialized as { counter: number },
      migrate: (state) => {
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
      boundary: "test rollback",
      fixture: {
        expected: true,
        name: "legacy state",
        serialized: '{"unrelated":"original"}',
        source: "test@v0",
      },
      hydrate: (serialized) => serialized as Record<string, unknown>,
      migrate: (state) => {
        state.canonical = { version: 1 };
        return true;
      },
      rollback: {
        apply: (original, interrupted) => ({ ...original, canonical: interrupted.canonical }),
        preservedKeys: ["canonical"],
      },
      serialize: (state) => state,
    });

    expect(result.rollbackSerialized).toEqual({
      canonical: { version: 1 },
      unrelated: "original",
    });
    expect(result.rollback?.serialized).toEqual(result.first.serialized);
  });

  it("rejects vacuous rollback assertions", async () => {
    await expect(
      assertDurableBoundaryCompatibility({
        boundary: "test rollback",
        fixture: {
          expected: true,
          name: "missing key",
          serialized: "{}",
          source: "test@v0",
        },
        hydrate: (serialized) => serialized as Record<string, unknown>,
        migrate: () => true,
        rollback: {
          apply: (original) => original,
          preservedKeys: ["canonical"],
        },
        serialize: (state) => state,
      }),
    ).rejects.toThrow('did not produce preserved key "canonical"');
  });

  it("rejects drift between an executable producer and frozen JSON", async () => {
    await expect(
      assertDurableBoundaryCompatibility({
        boundary: "test capture",
        fixture: {
          capture: () => ({ version: 2 }),
          expected: true,
          name: "captured value",
          serialized: '{"version":1}',
          source: "test@v1",
        },
        hydrate: (serialized) => serialized,
        migrate: () => true,
        serialize: (state) => state,
      }),
    ).rejects.toThrow("no longer matches its historical producer");
  });
});
