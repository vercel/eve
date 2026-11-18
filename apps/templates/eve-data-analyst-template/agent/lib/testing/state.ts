/**
 * In-memory stand-in for `eve/context` in unit tests.
 *
 * @packageDocumentation
 */
import type { StateHandle } from "eve/context";
import { vi } from "vitest";
import { z } from "zod";

import type { JsonValue } from "../json";
import { stateProvider } from "../state";

const values = new Map<string, unknown>();
const names = new Set<string>();

/**
 * Creates a name-keyed state handle backed by cloned in-memory checkpoints.
 *
 * @typeParam T - Value stored under this application-owned state name.
 * @param name - Durable slot name used by the production adapter.
 * @param initial - Value factory used when the slot has no saved checkpoint.
 * @returns A handle sharing the test store with other handles for the same slot.
 * @remarks Updates use structuredClone so tests cannot accidentally rely on shared mutable references.
 */
const defineState = <T>(name: string, initial: () => T): StateHandle<T> => {
  names.add(name);
  // SAFETY: Each durable slot has one application-owned type; tests seed that same type and updates preserve it.
  const read = (): T =>
    values.has(name) ? (values.get(name) as T) : initial();
  return {
    get: read,
    update(fn) {
      values.set(name, structuredClone(fn(read())));
    },
  };
};

/* Test controls for the values behind every handle created above. */
export const testState = {
  /* Reads a slot by its durable name without its initial value. */
  get(name: string): JsonValue {
    const value = values.get(name);
    return value === undefined ? value : z.json().parse(value);
  },
  /* Names of every state slot defined by the modules under test. */
  names(): string[] {
    return [...names];
  },
  /* Clears stored values; slot names stay registered. */
  reset(): void {
    values.clear();
  },
  /* Seeds a slot by its durable name, as a resumed session would. */
  set<T>(name: string, value: T): void {
    values.set(name, structuredClone(value));
  },
};

/**
 * Installs the in-memory state provider through the application's explicit state interface.
 *
 * @returns Installs a Vitest spy that is restored by the suite's normal mock lifecycle.
 * @remarks Call in beforeEach before exercising adapters that access durable state.
 */
export const installTestState = () => {
  vi.spyOn(stateProvider, "create").mockImplementation(defineState);
};
