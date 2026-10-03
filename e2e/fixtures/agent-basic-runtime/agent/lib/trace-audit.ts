import type { SpanProcessor } from "eve/instrumentation/otel";

interface AuditSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Readonly<Record<string, unknown>>;
}

const spans: AuditSpan[] = [];

export const traceAuditProcessor: SpanProcessor = {
  onStart(value) {
    const span = value as {
      name?: string;
      attributes?: Readonly<Record<string, unknown>>;
      spanContext?: () => { traceId: string; spanId: string };
      parentSpanContext?: { spanId: string };
    };
    if (span.spanContext === undefined || span.name === undefined) return;
    const reference = span.spanContext();
    spans.push({
      name: span.name,
      ...reference,
      parentSpanId: span.parentSpanContext?.spanId,
      attributes: { ...span.attributes },
    });
    while (spans.length > 128) spans.shift();
  },
  onEnd() {},
  async forceFlush() {},
  async shutdown() {},
};

export function inspectTrace(runId: string) {
  const owned = spans.filter((span) => span.attributes["agent.run.id"] === runId);
  const tool = [...owned].reverse().find((span) => span.name === "execute_tool inspect_trace");
  const step =
    tool === undefined
      ? undefined
      : [...owned]
          .reverse()
          .find((span) => span.name === "agent.step" && span.traceId === tool.traceId);
  const model =
    step === undefined
      ? undefined
      : owned.find((span) => span.name.startsWith("chat ") && span.parentSpanId === step.spanId);
  return {
    modelStep: tool !== undefined && step !== undefined && model !== undefined,
    identity:
      tool !== undefined &&
      [tool, step, model].every(
        (span) =>
          span !== undefined &&
          span.traceId === tool.traceId &&
          span.attributes["agent.trace.schema.version"] === 4 &&
          typeof span.attributes["gen_ai.conversation.id"] === "string",
      ),
  };
}
