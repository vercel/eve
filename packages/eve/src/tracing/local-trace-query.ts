import type { LocalTraceSummary } from "#tracing/local-trace-summary.js";

export type LocalTraceSortBy = "duration" | "failures" | "inputTokens" | "latest";

export interface LocalTraceQueryFilter {
  readonly agentName?: string;
  /** Selects traces containing error spans, not necessarily failed activations. */
  readonly failedOnly?: boolean;
  readonly sessionId?: string;
  readonly toolName?: string;
}

/** Filters whole traces without restricting their totals to matching spans. */
export function queryLocalTraceSummaries(
  summaries: readonly LocalTraceSummary[],
  options: LocalTraceQueryFilter & { readonly limit: number; readonly sortBy: LocalTraceSortBy },
): { readonly matches: readonly LocalTraceSummary[]; readonly truncated: boolean } {
  const matches = summaries.filter((summary) => matchesFilter(summary, options));
  matches.sort((left, right) => compareSummaries(left, right, options.sortBy));
  return { matches: matches.slice(0, options.limit), truncated: matches.length > options.limit };
}

function matchesFilter(summary: LocalTraceSummary, filter: LocalTraceQueryFilter): boolean {
  return (
    (filter.agentName === undefined || summary.agentNames.includes(filter.agentName)) &&
    (filter.sessionId === undefined || summary.sessionIds.includes(filter.sessionId)) &&
    (filter.toolName === undefined || summary.toolNames.includes(filter.toolName)) &&
    (filter.failedOnly !== true || summary.errorSpanCount > 0)
  );
}

function compareSummaries(
  left: LocalTraceSummary,
  right: LocalTraceSummary,
  sortBy: LocalTraceSortBy,
): number {
  const difference =
    sortBy === "duration"
      ? right.durationMs - left.durationMs
      : sortBy === "failures"
        ? right.errorSpanCount - left.errorSpanCount
        : sortBy === "inputTokens"
          ? right.inputTokens - left.inputTokens
          : Date.parse(right.startedAt) - Date.parse(left.startedAt);
  return difference || left.traceId.localeCompare(right.traceId);
}
