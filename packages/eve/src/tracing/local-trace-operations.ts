import type { LocalTraceSpan } from "#tracing/local-trace-reader.js";

export interface LocalTraceOperation {
  readonly span: LocalTraceSpan;
  readonly category: "model" | "other" | "tool";
  readonly actionDurationMs?: number;
}

export function uniqueLocalTraceSpans(spans: readonly LocalTraceSpan[]): LocalTraceSpan[] {
  const byId = new Map<string, LocalTraceSpan>();
  for (const span of spans) {
    if (!byId.has(span.spanId)) byId.set(span.spanId, span);
  }
  return [...byId.values()];
}

/** Pairs action wrappers with execution spans without constructing a sorted timeline. */
export function localTraceOperations(spans: readonly LocalTraceSpan[]): LocalTraceOperation[] {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const pairedActions = new Set<string>();
  const operations: LocalTraceOperation[] = [];
  for (const span of spans) {
    const category = categoryFor(span);
    if (category === undefined) continue;
    const action = span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId);
    if (
      span.attributes["gen_ai.operation.name"] === "execute_tool" &&
      action?.name === "agent.action" &&
      traceToolName(action) === traceToolName(span)
    ) {
      pairedActions.add(action.spanId);
      operations.push({
        category,
        span: {
          ...span,
          attributes: { ...action.attributes, ...span.attributes },
          parentSpanId: action.parentSpanId,
          statusCode: action.statusCode === 2 ? action.statusCode : span.statusCode,
          statusMessage: action.statusCode === 2 ? action.statusMessage : span.statusMessage,
        },
        ...(action.attributes["agent.action.kind"] === "subagent-call"
          ? { actionDurationMs: Number(action.endTimeNs - action.startTimeNs) / 1_000_000 }
          : {}),
      });
    } else {
      operations.push({ category, span });
    }
  }
  return operations.filter(({ span }) => !pairedActions.has(span.spanId));
}

function categoryFor(span: LocalTraceSpan): LocalTraceOperation["category"] | undefined {
  if (span.attributes["gen_ai.operation.name"] === "chat") return "model";
  if (span.attributes["gen_ai.operation.name"] === "execute_tool") return "tool";
  if (span.name === "agent.action") {
    return span.attributes["agent.action.kind"] === "tool-call" ? "tool" : "other";
  }
  return undefined;
}

export function traceModelName(span: LocalTraceSpan): string | undefined {
  return (
    traceStringAttribute(span, "agent.model.id") ??
    traceStringAttribute(span, "gen_ai.request.model")
  );
}

export function traceToolName(span: LocalTraceSpan): string | undefined {
  return (
    traceStringAttribute(span, "gen_ai.tool.name") ??
    traceStringAttribute(span, "agent.action.name")
  );
}

export function traceSessionId(span: LocalTraceSpan): string | undefined {
  return (
    traceStringAttribute(span, "agent.run.id") ?? traceStringAttribute(span, "agent.session.id")
  );
}

export function traceStringAttribute(span: LocalTraceSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
