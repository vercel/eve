import type { LocalTraceSpan } from "#tracing/local-trace-reader.js";
import { AGENT_USAGE_ATTRIBUTES } from "#tracing/agent-span-contract.js";
import {
  localTraceOperations,
  traceModelName,
  traceSessionId,
  traceStringAttribute,
  traceToolName,
  uniqueLocalTraceSpans,
} from "#tracing/local-trace-operations.js";

/** Structural metadata and totals for one retained trace, not its final outcome. */
export interface LocalTraceSummary {
  readonly traceId: string;
  readonly startedAt: string;
  /** Elapsed time from the earliest span start to the latest span end. */
  readonly durationMs: number;
  readonly spanCount: number;
  readonly agentNames: readonly string[];
  readonly conversationIds: readonly string[];
  readonly sessionIds: readonly string[];
  readonly models: readonly string[];
  readonly toolNames: readonly string[];
  readonly modelCalls: number;
  readonly toolCalls: number;
  /** Error-bearing spans; one failure can be recorded on multiple ancestors. */
  readonly errorSpanCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Total gateway cost in USD; undefined when no step reported cost. */
  readonly costUsd?: number;
}

/**
 * Only agent.step spans contribute usage: model spans repeat the same counters.
 * Operation counts collapse action/execution pairs, but error counts retain all
 * error-bearing spans so summaries agree with the raw trace tree.
 */
export function summarizeLocalTrace(
  traceId: string,
  spans: readonly LocalTraceSpan[],
): LocalTraceSummary {
  const unique = uniqueLocalTraceSpans(spans);
  const models = new Set<string>();
  const agentNames = new Set<string>();
  const conversationIds = new Set<string>();
  const sessionIds = new Set<string>();
  let start = unique[0]?.startTimeNs ?? 0n;
  let end = start;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd: number | undefined;
  let errorSpanCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const span of unique) {
    if (span.startTimeNs < start) start = span.startTimeNs;
    if (span.endTimeNs > end) end = span.endTimeNs;
    add(models, traceModelName(span));
    add(agentNames, traceStringAttribute(span, "agent.name"));
    add(conversationIds, traceStringAttribute(span, "gen_ai.conversation.id"));
    add(sessionIds, traceSessionId(span));
    if (span.statusCode === 2) errorSpanCount += 1;
    if (span.name !== "agent.step") continue;
    inputTokens += numberAttribute(span, "agent.usage.input_tokens") ?? 0;
    outputTokens += numberAttribute(span, "agent.usage.output_tokens") ?? 0;
    cacheReadTokens +=
      numberAttribute(span, AGENT_USAGE_ATTRIBUTES.cacheReadTokens) ??
      numberAttribute(span, "gen_ai.usage.cache_read.input_tokens") ??
      0;
    cacheWriteTokens +=
      numberAttribute(span, AGENT_USAGE_ATTRIBUTES.cacheWriteTokens) ??
      numberAttribute(span, "gen_ai.usage.cache_creation.input_tokens") ??
      0;
    const cost = localTraceSpanCostUsd(span);
    if (cost !== undefined) costUsd = (costUsd ?? 0) + cost;
  }
  const toolNames = new Set<string>();
  let modelCalls = 0;
  let toolCalls = 0;
  for (const operation of localTraceOperations(unique)) {
    if (operation.category === "model") modelCalls += 1;
    if (operation.category === "tool") {
      toolCalls += 1;
      add(toolNames, traceToolName(operation.span));
    }
  }
  return {
    traceId,
    startedAt: new Date(Number(start / 1_000_000n)).toISOString(),
    durationMs: Number(end - start) / 1_000_000,
    spanCount: unique.length,
    agentNames: [...agentNames].sort(),
    conversationIds: [...conversationIds].sort(),
    sessionIds: [...sessionIds].sort(),
    models: [...models].sort(),
    toolNames: [...toolNames].sort(),
    modelCalls,
    toolCalls,
    errorSpanCount,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    inputTokens,
    outputTokens,
  };
}

export function localTraceSpanCostUsd(span: LocalTraceSpan): number | undefined {
  return (
    numberAttribute(span, "gen_ai.usage.gateway_cost") ?? numberAttribute(span, "gen_ai.usage.cost")
  );
}

function numberAttribute(span: LocalTraceSpan, key: string): number | undefined {
  const value = span.attributes[key];
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function add(values: Set<string>, value: string | undefined): void {
  if (value !== undefined) values.add(value);
}
