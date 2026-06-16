import { shouldMockAuthoredRuntimeModels } from "#runtime/agent/mock-model-adapter.js";

/**
 * Declarative description of the deterministic mock model surface used by
 * the AppHarness.
 */
export interface MockModelInput {
  /**
   * Authored model id applied to the resolved runtime model when overriding
   * from the default. When omitted the descriptor leaves the model unchanged.
   */
  readonly id?: string;
}

/**
 * A materialized mock model descriptor returned from {@link mockModel}.
 */
export interface MockModel {
  /** Effective model id applied to the resolved runtime model. */
  readonly id?: string;
  /**
   * Returns `true` when the mock adapter is active in the current process.
   * Always true when the unit/integration tiers run with `NODE_ENV=test`.
   */
  isActive(): boolean;
}

/**
 * Builds a {@link MockModel} descriptor for the AppHarness.
 *
 * The current implementation is intentionally thin: it delegates to the
 * existing auto-activated mock adapter so the full deterministic behaviour
 * (weather tool calls, skill load calls, bootstrap replies) is available
 * without further wiring.
 */
export function mockModel(input: MockModelInput = {}): MockModel {
  return {
    id: input.id,
    isActive() {
      return shouldMockAuthoredRuntimeModels();
    },
  };
}
