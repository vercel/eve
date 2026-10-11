import type { HarnessSessionBase } from "#harness/types.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextKey } from "#context/key.js";

export type { ContextReader } from "#context/key.js";

/**
 * Value returned by a framework provider's `create` method: the live
 * step-local instance stored on the context.
 */
export interface ProviderResult<T> {
  readonly value: T;
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
    session: HarnessSessionBase,
  ): ProviderResult<T> | undefined | Promise<ProviderResult<T> | undefined>;

  commit?<S extends HarnessSessionBase>(value: T, session: S): S | Promise<S>;

  /** Rolls back provider-owned effects when the callback or a later commit fails. */
  rollback?(value: T, cause: unknown): void | Promise<void>;
}
