import type { SpanProcessor } from "eve/instrumentation/otel";

interface AuditSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Readonly<Record<string, unknown>>;
  finished: Promise<void>;
  finish: () => void;
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
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    spans.push({
      name: span.name,
      ...reference,
      parentSpanId: span.parentSpanContext?.spanId,
      attributes: { ...span.attributes },
      finished,
      finish,
    });
    while (spans.length > 128) spans.shift();
  },
  onEnd(value) {
    const span = value as {
      attributes: Readonly<Record<string, unknown>>;
      spanContext: () => { spanId: string };
    };
    const runId = span.attributes["agent.run.id"];
    if (typeof runId !== "string") return;
    const recorded = runs.get(runId)?.find((entry) => entry.spanId === span.spanContext().spanId);
    if (recorded !== undefined) {
      recorded.attributes = { ...span.attributes };
      recorded.finish();
    }
  },
  async forceFlush() {},
  async shutdown() {},
};

export async function inspectTrace(runId: string) {
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
  // Streaming tool calls can execute before the model's terminal callback.
  if (model !== undefined) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        model.finished,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 5_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    modelStep: step !== undefined && model !== undefined,
    content:
      typeof model?.attributes["gen_ai.input.messages"] === "string" &&
      typeof model?.attributes["gen_ai.output.messages"] === "string",
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
