import type { SpanProcessor } from "eve/instrumentation/otel";

interface AuditSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Readonly<Record<string, unknown>>;
}

// Instrumentation and tools load in separate bundles, so they share the buffer
// globally. Spans are kept per run so concurrent evals cannot evict each other's.
const runs = ((globalThis as Record<symbol, unknown>)[
  Symbol.for("agent-basic-runtime.trace-audit")
] ??= new Map()) as Map<string, AuditSpan[]>;

export const traceAuditProcessor: SpanProcessor = {
  onStart(value) {
    const span = value as {
      name?: string;
      attributes?: Readonly<Record<string, unknown>>;
      spanContext?: () => { traceId: string; spanId: string };
      parentSpanContext?: { spanId: string };
    };
    const runId = span.attributes?.["agent.run.id"];
    if (span.spanContext === undefined || span.name === undefined || typeof runId !== "string")
      return;
    const reference = span.spanContext();
    let spans = runs.get(runId);
    if (spans === undefined) {
      spans = [];
      runs.set(runId, spans);
      if (runs.size > 64) runs.delete(runs.keys().next().value!);
    }
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
  const owned = runs.get(runId) ?? [];
  // The tool's own span is durable and starts only when the call completes, so
  // the audit reads the step that requested it and that step's model call.
  const modelOf = (step: AuditSpan) =>
    owned.find(
      (span) =>
        span.name.startsWith("chat ") &&
        span.parentSpanId === step.spanId &&
        span.traceId === step.traceId,
    );
  const step = [...owned]
    .reverse()
    .find((span) => span.name === "agent.step" && modelOf(span) !== undefined);
  const model = step === undefined ? undefined : modelOf(step);
  return {
    modelStep: step !== undefined && model !== undefined,
    identity:
      step !== undefined &&
      model !== undefined &&
      [step, model].every(
        (span) =>
          span.attributes["agent.trace.schema.version"] === 4 &&
          typeof span.attributes["gen_ai.conversation.id"] === "string",
      ),
  };
}
