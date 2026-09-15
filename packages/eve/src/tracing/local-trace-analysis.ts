import type { LocalTraceSpan } from "#tracing/local-trace-reader.js";
import {
  localTraceOperations,
  traceModelName,
  traceSessionId,
  traceStringAttribute,
  traceToolName,
  uniqueLocalTraceSpans,
  type LocalTraceOperation,
} from "#tracing/local-trace-operations.js";
import { summarizeLocalTrace, type LocalTraceSummary } from "#tracing/local-trace-summary.js";

export interface TraceAnalysisSelector {
  readonly excludeSessionId?: string;
  readonly fromMs?: number;
  readonly sessionId?: string;
  readonly toMs?: number;
  readonly turnId?: string;
}

export interface TraceTokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface TraceTimelineRecord {
  readonly actionDurationMs?: number;
  readonly actionName?: string;
  readonly callId?: string;
  readonly category: "model" | "other" | "tool";
  readonly durationMs: number;
  readonly endOffsetMs: number;
  readonly error?: string;
  readonly model?: string;
  readonly outcome: "completed" | "failed";
  readonly parentSpanId?: string;
  readonly sessionId?: string;
  readonly spanId: string;
  readonly startOffsetMs: number;
  readonly toolName?: string;
  readonly turnId?: string;
  readonly usage?: TraceTokenUsage;
}

export interface TraceAnalysis {
  readonly summary: LocalTraceSummary;
  readonly groups: readonly TraceAnalysisGroup[];
  /** Accumulated operation time, not elapsed time; parallel calls can overlap. */
  readonly modelWorkMs: number;
  readonly toolWorkMs: number;
  readonly records: readonly TraceTimelineRecord[];
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

export interface TraceAnalysisGroup {
  readonly modelWorkMs: number;
  readonly modelCalls: number;
  readonly sessionId?: string;
  readonly toolWorkMs: number;
  readonly toolCalls: number;
  readonly turnId?: string;
}

/** Builds the detailed timeline only when inspection, rather than search, needs it. */
export function analyzeLocalTrace(
  traceId: string,
  spans: readonly LocalTraceSpan[],
  selector: TraceAnalysisSelector = {},
): TraceAnalysis {
  const unique = uniqueLocalTraceSpans(spans);
  const inherited = new Map(localTraceOperations(unique).map(({ span }) => [span.spanId, span]));
  const selected = unique.filter((span) => matches(inherited.get(span.spanId) ?? span, selector));
  const startTimeNs = selected.reduce(
    (start, span) => (span.startTimeNs < start ? span.startTimeNs : start),
    selected[0]?.startTimeNs ?? 0n,
  );
  const records = localTraceOperations(selected)
    .map((operation) => recordFor(operation, startTimeNs))
    .sort(
      (left, right) =>
        left.startOffsetMs - right.startOffsetMs ||
        left.endOffsetMs - right.endOffsetMs ||
        left.spanId.localeCompare(right.spanId),
    );
  return {
    summary: summarizeLocalTrace(traceId, selected),
    groups: groups(records),
    modelWorkMs: sum(records, "model"),
    toolWorkMs: sum(records, "tool"),
    records,
  };
}

function matches(span: LocalTraceSpan, selector: TraceAnalysisSelector): boolean {
  const sessionId = traceSessionId(span);
  const turnId = traceStringAttribute(span, "agent.turn.id");
  if (selector.excludeSessionId !== undefined && sessionId === selector.excludeSessionId)
    return false;
  if (selector.sessionId !== undefined && sessionId !== selector.sessionId) return false;
  if (selector.turnId !== undefined && turnId !== selector.turnId) return false;
  const startMs = Number(span.startTimeNs / 1_000_000n);
  return (
    (selector.fromMs === undefined || startMs >= selector.fromMs) &&
    (selector.toMs === undefined || startMs <= selector.toMs)
  );
}

function recordFor(operation: LocalTraceOperation, startTimeNs: bigint): TraceTimelineRecord {
  const { span, category } = operation;
  const durationMs = Number(span.endTimeNs - span.startTimeNs) / 1_000_000;
  const record: Mutable<TraceTimelineRecord> = {
    category,
    durationMs,
    endOffsetMs: Number(span.endTimeNs - startTimeNs) / 1_000_000,
    outcome: span.statusCode === 2 ? "failed" : "completed",
    spanId: span.spanId,
    startOffsetMs: Number(span.startTimeNs - startTimeNs) / 1_000_000,
  };
  const callId = traceStringAttribute(span, "agent.action.call_id");
  const model = traceModelName(span);
  const sessionId = traceSessionId(span);
  const name = traceToolName(span);
  const turnId = traceStringAttribute(span, "agent.turn.id");
  if (callId !== undefined) record.callId = callId;
  if (span.statusMessage !== undefined) record.error = span.statusMessage;
  if (model !== undefined) record.model = model;
  if (span.parentSpanId !== undefined) record.parentSpanId = span.parentSpanId;
  if (sessionId !== undefined) record.sessionId = sessionId;
  if (name !== undefined && category === "tool") record.toolName = name;
  if (name !== undefined && category === "other") record.actionName = name;
  if (turnId !== undefined) record.turnId = turnId;
  if (operation.actionDurationMs !== undefined)
    record.actionDurationMs = operation.actionDurationMs;
  if (category === "model") {
    const usage: Mutable<TraceTokenUsage> = {};
    for (const [field, attribute] of Object.entries({
      inputTokens: "agent.usage.input_tokens",
      outputTokens: "agent.usage.output_tokens",
      cacheReadTokens: "agent.usage.cache_read_tokens",
      cacheWriteTokens: "agent.usage.cache_write_tokens",
    })) {
      const value = span.attributes[attribute];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        usage[field as keyof TraceTokenUsage] = value;
      }
    }
    if (Object.keys(usage).length > 0) record.usage = usage;
  }
  return record;
}

function groups(records: readonly TraceTimelineRecord[]): TraceAnalysisGroup[] {
  const values = new Map<string, Mutable<TraceAnalysisGroup>>();
  for (const record of records) {
    const key = JSON.stringify([record.sessionId, record.turnId]);
    let group = values.get(key);
    if (group === undefined) {
      group = { modelCalls: 0, modelWorkMs: 0, toolCalls: 0, toolWorkMs: 0 };
      if (record.sessionId !== undefined) group.sessionId = record.sessionId;
      if (record.turnId !== undefined) group.turnId = record.turnId;
      values.set(key, group);
    }
    if (record.category === "model") {
      group.modelCalls += 1;
      group.modelWorkMs += record.durationMs;
    }
    if (record.category === "tool") {
      group.toolCalls += 1;
      group.toolWorkMs += record.durationMs;
    }
  }
  return [...values.values()];
}

function sum(records: readonly TraceTimelineRecord[], category: "model" | "tool"): number {
  return records.reduce(
    (total, record) => total + (record.category === category ? record.durationMs : 0),
    0,
  );
}
