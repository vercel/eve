import { describe, expect, it } from "vitest";

import { defineCell, defineEffect } from "./definitions.js";
import { ComputeError } from "./errors.js";

const schema = {
  parse(value: unknown): unknown {
    return value;
  },
};

describe("compute definitions", () => {
  it("returns validated cell definitions unchanged", () => {
    const definition = {
      stateVersion: 1,
      messageVersion: 1,
      stateSchema: schema,
      messageSchema: schema,
      initial: () => ({ count: 0 }),
      receive: (state: { count: number }) => ({ state }),
      migrateState: (_version: number, value: unknown) => value as { count: number },
      migrateMessage: (_version: number, value: unknown) => value,
    };

    expect(defineCell(definition)).toBe(definition);
  });

  it("rejects incomplete or invalid cell definitions", () => {
    expect(() =>
      defineCell({
        stateVersion: 0,
        messageVersion: 1,
        stateSchema: schema,
        messageSchema: schema,
        initial: () => null,
        receive: () => ({ state: null }),
        migrateState: () => null,
        migrateMessage: () => null,
      }),
    ).toThrowError(ComputeError);

    expect(() =>
      defineCell({
        stateVersion: 1,
        messageVersion: 1,
        stateSchema: {} as never,
        messageSchema: schema,
        initial: () => null,
        receive: () => ({ state: null }),
        migrateState: () => null,
        migrateMessage: () => null,
      }),
    ).toThrow(/stateSchema\.parse/u);
  });

  it("validates effect versions and retry policy", () => {
    const definition = {
      inputVersion: 1,
      outputVersion: 1,
      inputSchema: schema,
      outputSchema: schema,
      retry: { mode: "idempotent" as const, maxAttempts: 5, timeoutMs: 120_000 },
      execute: async (input: unknown) => input,
      migrateOutput: (_version: number, value: unknown) => value,
    };

    expect(defineEffect(definition)).toBe(definition);
    expect(() =>
      defineEffect({
        ...definition,
        retry: { mode: "idempotent", maxAttempts: 6, timeoutMs: 120_000 },
      }),
    ).toThrow(/1 to 5 attempts/u);
    expect(() =>
      defineEffect({
        ...definition,
        retry: { mode: "manual", timeoutMs: 900_001 },
      }),
    ).toThrow(/retry\.timeoutMs/u);
  });
});
