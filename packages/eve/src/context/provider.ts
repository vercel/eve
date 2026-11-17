import type { HarnessSessionBase } from "#harness/types.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextKey } from "#context/key.js";

export type { ContextReader } from "#context/key.js";

export interface ProviderResult<T> {
  readonly value: T;
}

export interface FrameworkContextProvider<T> {
  readonly key: ContextKey<T>;

  create(
    ctx: ContextContainer,
    session: HarnessSessionBase,
  ): ProviderResult<T> | undefined | Promise<ProviderResult<T> | undefined>;

  commit?<S extends HarnessSessionBase>(value: T, session: S): S | Promise<S>;

  rollback?(value: T, cause: unknown): void | Promise<void>;

  dispose?(value: T): void | Promise<void>;
}
