import type { LocalTraceSpan } from "#tracing/local-trace-reader.js";

export interface LocalTraceSpanSource {
  readonly segmentFile: string;
  readonly span: LocalTraceSpan;
}

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
  readonly durationMs: number;
  readonly failedOperations: number;
  readonly groups: readonly TraceAnalysisGroup[];
  readonly modelDurationMs: number;
  readonly modelCalls: number;
  readonly records: readonly TraceTimelineRecord[];
  readonly startTimeNs: bigint;
  readonly toolDurationMs: number;
  readonly toolCalls: number;
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

export interface TraceAnalysisGroup {
  readonly durationMs: number;
  readonly modelDurationMs: number;
  readonly modelCalls: number;
  readonly sessionId?: string;
  readonly toolDurationMs: number;
  readonly toolCalls: number;
  readonly turnId?: string;
}

/**
 * Projects persisted spans into the small, structural timeline needed for
 * latency analysis. It deliberately never inspects prompt or tool payloads.
 */
export function analyzeLocalTrace(
  sources: readonly LocalTraceSpanSource[],
  selector: TraceAnalysisSelector = {},
): TraceAnalysis {
  const unique = deduplicate(sources);
  const byId = new Map(unique.map(({ span }) => [span.spanId, span]));
  const pairedActions = new Set<string>();
  const logical = unique.map((source) => {
    const { span } = source;
    const action = span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId);
    if (
      span.attributes["gen_ai.operation.name"] !== "execute_tool" ||
      action?.name !== "agent.action" ||
      toolFor(action) !== toolFor(span)
    ) {
      return source;
    }
    pairedActions.add(action.spanId);
    return {
      ...source,
      span: {
        ...span,
        attributes: { ...action.attributes, ...span.attributes },
        parentSpanId: action.parentSpanId,
        statusCode: action.statusCode === 2 ? action.statusCode : span.statusCode,
        statusMessage: action.statusCode === 2 ? action.statusMessage : span.statusMessage,
      },
      actionDurationMs: Number(action.endTimeNs - action.startTimeNs) / 1_000_000,
    };
  });
  const spans = logical.filter(
    (source) => !pairedActions.has(source.span.spanId) && matches(source.span, selector),
  );
  const selected = unique.filter((source) => matches(source.span, selector));
  const startTimeNs = selected.reduce(
    (start, source) => (source.span.startTimeNs < start ? source.span.startTimeNs : start),
    selected[0]?.span.startTimeNs ?? 0n,
  );
  const records = spans.flatMap((source) => {
    const records = recordFor(source, startTimeNs);
    // A background action outlives its launch tool; retain that lifetime separately.
    if (
      "actionDurationMs" in source &&
      source.span.attributes["agent.action.kind"] === "subagent-call"
    ) {
      return records.map((record) => ({ ...record, actionDurationMs: source.actionDurationMs }));
    }
    return records;
  });
  const ordered = records.sort(
    (left, right) =>
      left.startOffsetMs - right.startOffsetMs ||
      left.endOffsetMs - right.endOffsetMs ||
      left.spanId.localeCompare(right.spanId),
  );
  const model = ordered.filter((record) => record.category === "model");
  const tools = ordered.filter((record) => record.category === "tool");
  return {
    durationMs:
      spans.length === 0
        ? 0
        : Number(
            selected.reduce(
              (end, source) => (source.span.endTimeNs > end ? source.span.endTimeNs : end),
              startTimeNs,
            ) - startTimeNs,
          ) / 1_000_000,
    failedOperations: spans.filter(({ span }) => span.statusCode === 2).length,
    groups: groups(ordered),
    modelCalls: model.length,
    modelDurationMs: sum(model),
    records: ordered,
    startTimeNs,
    toolCalls: tools.length,
    toolDurationMs: sum(tools),
  };
}

function deduplicate(sources: readonly LocalTraceSpanSource[]): LocalTraceSpanSource[] {
  const byId = new Map<string, LocalTraceSpanSource>();
  for (const source of sources) {
    if (!byId.has(source.span.spanId)) byId.set(source.span.spanId, source);
  }
  return [...byId.values()];
}

function matches(span: LocalTraceSpan, selector: TraceAnalysisSelector): boolean {
  const sessionId = traceSessionId(span);
  const turnId = stringAttribute(span, "agent.turn.id");
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

function recordFor(source: LocalTraceSpanSource, startTimeNs: bigint): TraceTimelineRecord[] {
  const { span } = source;
  const category = categoryFor(span);
  if (category === undefined) return [];
  const durationMs = Number(span.endTimeNs - span.startTimeNs) / 1_000_000;
  const record: Mutable<TraceTimelineRecord> = {
    category,
    durationMs,
    endOffsetMs: Number(span.endTimeNs - startTimeNs) / 1_000_000,
    outcome: span.statusCode === 2 ? "failed" : "completed",
    spanId: span.spanId,
    startOffsetMs: Number(span.startTimeNs - startTimeNs) / 1_000_000,
  };
  const callId = stringAttribute(span, "agent.action.call_id");
  const model = modelFor(span);
  const sessionId = traceSessionId(span);
  const toolName = toolFor(span);
  const turnId = stringAttribute(span, "agent.turn.id");
  if (callId !== undefined) record.callId = callId;
  if (span.statusMessage !== undefined) record.error = span.statusMessage;
  if (model !== undefined) record.model = model;
  if (span.parentSpanId !== undefined) record.parentSpanId = span.parentSpanId;
  if (sessionId !== undefined) record.sessionId = sessionId;
  if (toolName !== undefined) record.toolName = toolName;
  if (turnId !== undefined) record.turnId = turnId;
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
  return [record];
}

function categoryFor(span: LocalTraceSpan): TraceTimelineRecord["category"] | undefined {
  if (span.attributes["gen_ai.operation.name"] === "chat") return "model";
  if (span.attributes["gen_ai.operation.name"] === "execute_tool") return "tool";
  if (span.name === "agent.action") {
    return span.attributes["agent.action.kind"] === "tool-call" ? "tool" : "other";
  }
  return undefined;
}

function modelFor(span: LocalTraceSpan): string | undefined {
  return stringAttribute(span, "agent.model.id") ?? stringAttribute(span, "gen_ai.request.model");
}

function toolFor(span: LocalTraceSpan): string | undefined {
  return stringAttribute(span, "gen_ai.tool.name") ?? stringAttribute(span, "agent.action.name");
}

function groups(records: readonly TraceTimelineRecord[]): TraceAnalysisGroup[] {
  const values = new Map<string, TraceAnalysisGroup>();
  for (const record of records) {
    const key = `${record.sessionId ?? ""}:${record.turnId ?? ""}`;
    let current = values.get(key);
    if (current === undefined) {
      const created: Mutable<TraceAnalysisGroup> = {
        durationMs: 0,
        modelCalls: 0,
        modelDurationMs: 0,
        toolCalls: 0,
        toolDurationMs: 0,
      };
      if (record.sessionId !== undefined) created.sessionId = record.sessionId;
      if (record.turnId !== undefined) created.turnId = record.turnId;
      current = created;
    }
    const next = {
      ...current,
      durationMs: current.durationMs + record.durationMs,
      ...(record.category === "model"
        ? {
            modelCalls: current.modelCalls + 1,
            modelDurationMs: current.modelDurationMs + record.durationMs,
          }
        : {}),
      ...(record.category === "tool"
        ? {
            toolCalls: current.toolCalls + 1,
            toolDurationMs: current.toolDurationMs + record.durationMs,
          }
        : {}),
    };
    values.set(key, next);
  }
  return [...values.values()];
}

function sum(records: readonly TraceTimelineRecord[]): number {
  return records.reduce((total, record) => total + record.durationMs, 0);
}

export function traceSessionId(span: LocalTraceSpan): string | undefined {
  return stringAttribute(span, "agent.run.id") ?? stringAttribute(span, "agent.session.id");
}

function stringAttribute(span: LocalTraceSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === "string" ? value : undefined;
}
