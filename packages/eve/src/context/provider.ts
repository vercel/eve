import type { HarnessSession, StepResult } from "#harness/types.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextKey } from "#context/key.js";

export type { ContextReader } from "#context/key.js";

/**
 * Value returned by a framework provider's `create` method.
 *
 * `value` is the live step-local instance stored on the context. `session`
 * carries an optional harness session patch produced while deriving that
 * value.
 */
export interface ProviderResult<T> {
  readonly value: T;
  readonly session?: HarnessSession;
}

/**
 * Framework-only provider contract.
 *
 * Framework providers may derive virtual values from context, observe the
 * current harness session, and optionally commit mutable provider-owned state
 * back onto the harness session after the authored step completes.
 */
export interface FrameworkContextProvider<T> {
  readonly key: ContextKey<T>;

  create(
    ctx: ContextContainer,
    session: HarnessSession,
  ): ProviderResult<T> | undefined | Promise<ProviderResult<T> | undefined>;

  commit?(value: T, session: HarnessSession): HarnessSession | Promise<HarnessSession>;

  /** Rolls back provider-owned effects when the callback or a later commit fails. */
  rollback?(value: T, cause: unknown): void | Promise<void>;

  /** Adds provider-owned durable effects to a successfully committed harness step. */
  decorateStepResult?(value: T, result: StepResult): StepResult | Promise<StepResult>;
}
