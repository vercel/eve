import type { HarnessSession, StepResult } from "#harness/types.js";
import { type ContextContainer, contextStorage } from "#context/container.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import { connectionProvider } from "#context/providers/connection.js";
import { sandboxProvider } from "#context/providers/sandbox.js";
import { sessionProvider } from "#context/providers/session.js";

/**
 * Framework providers in dependency order.
 *
 * Session runs first (depends only on durable seed values). Later providers
 * may read framework-derived virtual values through the unified context view.
 */
const frameworkProviders: readonly FrameworkContextProvider<any>[] = [
  sessionProvider,
  connectionProvider,
  sandboxProvider,
];

interface ContextScopeResult<T> {
  readonly result: T;
  readonly session: HarnessSession;
}

/**
 * Runs `callback` inside a fully-initialized ALS scope with all framework
 * providers (session, connection, sandbox) built and committed.
 *
 * The callback receives the enriched session and must return both its own
 * result and the (possibly mutated) session so provider commit hooks can
 * persist provider-owned state (e.g. sandbox snapshots).
 */
export async function withContextScope<T>(
  ctx: ContextContainer,
  harnessSession: HarnessSession,
  callback: (session: HarnessSession) => Promise<ContextScopeResult<T>>,
): Promise<ContextScopeResult<T>> {
  const createdProviders: Array<{
    readonly provider: FrameworkContextProvider<any>;
    readonly value: unknown;
  }> = [];
  let output: ContextScopeResult<T> | undefined;
  let failure: unknown;
  let failed = false;

  try {
    let session = harnessSession;

    ctx.clearVirtualContext();

    for (const provider of frameworkProviders) {
      const result = await provider.create(ctx, session);
      if (result !== undefined) {
        ctx.setVirtualContext(provider.key, result.value);
        createdProviders.push({ provider, value: result.value });
        if (result.session !== undefined) {
          session = result.session;
        }
      }
    }

    const scopeResult = await contextStorage.run(ctx, () => callback(session));

    let committed = scopeResult.session;
    for (const provider of frameworkProviders) {
      if (provider.commit && ctx.has(provider.key)) {
        committed = await provider.commit(ctx.require(provider.key), committed);
      }
    }

    output =
      committed === scopeResult.session
        ? scopeResult
        : { result: scopeResult.result, session: committed };
  } catch (error) {
    failed = true;
    failure = error;
  }

  const disposalErrors: unknown[] = [];
  for (const { provider, value } of createdProviders.reverse()) {
    if (provider.dispose) {
      try {
        await provider.dispose(value);
      } catch (error) {
        disposalErrors.push(error);
      }
    }
  }

  if (failed) {
    if (disposalErrors.length > 0) {
      throw new AggregateError(
        [failure, ...disposalErrors],
        "The step failed and context cleanup also failed.",
      );
    }
    throw failure;
  }
  if (disposalErrors.length > 0) {
    throw new AggregateError(disposalErrors, "Context cleanup failed.");
  }
  if (output === undefined) {
    throw new Error("Context scope completed without a result.");
  }
  return output;
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
  const { result, session } = await withContextScope(ctx, harnessSession, async (enriched) => {
    const stepResult = await callback(enriched);
    return { result: stepResult.next, session: stepResult.session };
  });

  return { next: result, session };
}
