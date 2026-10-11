import type { HarnessSession, HarnessSessionBase, StepResult } from "#harness/types.js";
import { type ContextContainer, contextStorage } from "#context/container.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import { connectionProvider } from "#context/providers/connection.js";
import { sandboxProvider } from "#context/providers/sandbox.js";
import { sessionProvider } from "#context/providers/session.js";
import { toolStubProvider } from "#context/providers/tool-stubs.js";

/**
 * Framework providers in dependency order.
 *
 * Session runs first (depends only on durable seed values). Later providers
 * may read framework-derived virtual values through the unified context view.
 */
const frameworkProviders: readonly FrameworkContextProvider<any>[] = [
  sessionProvider,
  toolStubProvider,
  connectionProvider,
  sandboxProvider,
];

interface ContextScopeResult<T, S extends HarnessSessionBase> {
  readonly result: T;
  readonly session: S;
}

/**
 * Runs `callback` inside a fully-initialized ALS scope with all framework
 * providers (session, connection, sandbox) built and committed.
 *
 * The callback receives the enriched session and must return both its own
 * result and the (possibly mutated) session so provider commit hooks can
 * persist provider-owned state (e.g. sandbox snapshots).
 */
export async function withContextScope<T, S extends HarnessSessionBase>(
  ctx: ContextContainer,
  session: S,
  callback: (session: S) => Promise<ContextScopeResult<T, S>>,
): Promise<ContextScopeResult<T, S>> {
  const createdProviders: FrameworkContextProvider<any>[] = [];

  ctx.clearVirtualContext();

  try {
    for (const provider of frameworkProviders) {
      const result = await provider.create(ctx, session);
      if (result !== undefined) {
        ctx.setVirtualContext(provider.key, result.value);
        createdProviders.push(provider);
      }
    }

    const scopeResult = await contextStorage.run(ctx, () => callback(session));

    let committed = scopeResult.session;
    for (const provider of createdProviders) {
      if (provider.commit !== undefined) {
        committed = await provider.commit(ctx.require(provider.key), committed);
      }
    }

    if (committed === scopeResult.session) {
      return scopeResult;
    }

    return { result: scopeResult.result, session: committed };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const provider of createdProviders.toReversed()) {
      if (provider.rollback === undefined) continue;
      try {
        await provider.rollback(ctx.require(provider.key), error);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Framework context rollback did not complete.",
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Runs one harness step inside the unified context.
 *
 * Delegates to {@link withContextScope} for provider lifecycle, then
 * reassembles the {@link StepResult}.
 */
export async function runStep(
  ctx: ContextContainer,
  harnessSession: HarnessSession,
  callback: (session: HarnessSession) => Promise<StepResult>,
): Promise<StepResult> {
  const scoped = await withContextScope(ctx, harnessSession, async (enriched) => {
    const result = await callback(enriched);
    return { result, session: result.session };
  });
  return { ...scoped.result, session: scoped.session };
}
