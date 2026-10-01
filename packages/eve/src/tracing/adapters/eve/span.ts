import {
  trace,
  SpanKind,
  type Context,
  type Span,
  type Tracer,
} from "#compiled/@opentelemetry/api/index.js";
import { createTraceEngine } from "#tracing/core/engine.js";
import { liveOtelBackend } from "#tracing/adapters/otel.js";
import { eveOutputMapping } from "#tracing/adapters/eve/compatibility.js";
import type { SpanType, TraceLink } from "#tracing/core/types.js";

type SpanOptions = NonNullable<Parameters<Tracer["startSpan"]>[1]>;

/** Keeps eve's full parent context while the shared engine creates and maps the span. */
export function startEveSpan(input: {
  readonly tracer: Tracer;
  readonly type: SpanType;
  readonly operationId: string;
  readonly name: string;
  readonly options?: SpanOptions;
  readonly parent?: Context;
}): Span {
  let recorded: Span | undefined;
  const tracer = {
    startSpan(name: string, options?: SpanOptions) {
      recorded = input.tracer.startSpan(
        name,
        {
          ...input.options,
          ...options,
          startTime: input.options?.startTime,
          links:
            options?.links === undefined || options.links.length === 0
              ? input.options?.links
              : options.links,
        },
        input.parent,
      );
      return recorded;
    },
  } as Tracer;
  const engine = createTraceEngine({ backend: liveOtelBackend(tracer, eveOutputMapping()) });
  const links: TraceLink[] = [];
  for (const link of input.options?.links ?? []) {
    const relationship = link.attributes?.["eve.link.type"];
    if (
      relationship === "agent.dispatch" ||
      relationship === "channel.request" ||
      relationship === "workflow.delivery"
    ) {
      links.push({
        context: link.context,
        relationship: relationship === "workflow.delivery" ? "execution.delivery" : relationship,
      });
    }
  }
  const operation = engine.start(
    {
      type: input.type,
      operationId: input.operationId,
      name: input.name,
      kind:
        input.options?.kind === undefined
          ? undefined
          : input.options.kind === SpanKind.SERVER
            ? "SERVER"
            : input.options.kind === SpanKind.CLIENT
              ? "CLIENT"
              : "INTERNAL",
      root: input.options?.root,
      attributes: input.options?.attributes ?? {},
      links,
      startTimeMs:
        typeof input.options?.startTime === "number" ? input.options.startTime : undefined,
    },
    // The lifecycle bus has already applied eve's audience and directional ceiling.
    { emit: true, recordInputs: true, recordOutputs: true },
  );
  const span = recorded ?? trace.wrapSpanContext(operation.reference);
  return new Proxy(span, {
    get(target, key) {
      if (key === "setAttribute")
        return (name: string, value: Parameters<Span["setAttribute"]>[1]) => {
          operation.setAttribute(name, value);
          return target;
        };
      if (key === "end") return (time?: number) => operation.end(time);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
