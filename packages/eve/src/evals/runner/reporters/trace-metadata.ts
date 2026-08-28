import type { EveEvalTraceContext } from "#evals/types.js";

/** Metadata convention shared by trace-aware eval reporters. */
export function buildEvalTraceMetadata(
  traceContexts: readonly EveEvalTraceContext[],
): Readonly<Record<string, unknown>> {
  if (traceContexts.length === 0) return {};

  return {
    eveTraceContexts: traceContexts,
    eveTraceIds: [...new Set(traceContexts.map((traceContext) => traceContext.traceId))],
  };
}
