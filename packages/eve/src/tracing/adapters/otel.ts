import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Context,
  type Tracer,
} from "#compiled/@opentelemetry/api/index.js";
import { recordAgentSpanError } from "#tracing/agent-span-error.js";
import { withErrorContent } from "#tracing/error-content-context.js";
import { suppressTracing } from "#tracing/suppress-tracing.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type {
  Attributes,
  DurableTraceBackend,
  OutputMapping,
  PreparedSpan,
  SpanWriter,
  TraceBackend,
  TraceReference,
} from "#tracing/core/types.js";

function parentContext(reference: TraceReference | undefined): Context {
  return reference === undefined
    ? ROOT_CONTEXT
    : trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(reference));
}

function mappedAttributes(
  mapping: OutputMapping | undefined,
  span: PreparedSpan,
  attributes: Attributes,
): Attributes {
  return mapping?.attributes(span, attributes) ?? attributes;
}

export function liveOtelBackend(tracer: Tracer, mapping?: OutputMapping): TraceBackend {
  function start(span: PreparedSpan): SpanWriter {
    const recorded = tracer.startSpan(
      mapping?.name?.(span, span.name) ?? span.name,
      {
        attributes: mappedAttributes(mapping, span, span.attributes),
        kind: span.kind === undefined ? undefined : SpanKind[span.kind],
        root: span.root,
        startTime: span.startTimeMs,
        links: span.links?.map(
          (link) =>
            mapping?.link(span, link) ?? {
              context: link.context,
              attributes: { "agent.link.type": link.relationship },
            },
        ),
      },
      parentContext(span.root ? undefined : span.parent),
    );
    return {
      reference: recorded.spanContext(),
      setAttribute(key, value) {
        for (const [name, mapped] of Object.entries(
          mappedAttributes(mapping, span, { [key]: value }),
        )) {
          if (mapped !== undefined) recorded.setAttribute(name, mapped);
        }
      },
      addEvent: (name, attributes, timeMs) => {
        recorded.addEvent(name, attributes, timeMs);
      },
      fail: (error, errorType) => recordAgentSpanError(recorded, error, errorType),
      setStatus: (code) => {
        recorded.setStatus({ code: SpanStatusCode[code] });
      },
      end: (timeMs) => {
        recorded.end(timeMs);
      },
    };
  }
  return {
    start,
    current: () => trace.getSpan(context.active())?.spanContext(),
    run(reference, capture, execute) {
      // Retain baggage and host context while replacing the semantic parent span.
      let active = trace.setSpan(context.active(), trace.wrapSpanContext(reference));
      active = withErrorContent(active, capture.recordOutputs);
      if (!capture.emit || (reference.traceFlags & 1) === 0) active = suppressTracing(active);
      return context.with(active, execute);
    },
  };
}

export function durableOtelBackend(input: {
  readonly tracer: Tracer;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly samplesTrace: (
    traceId: string,
    operation: { name: string; attributes: Attributes },
  ) => boolean;
  readonly mapping?: OutputMapping;
}): DurableTraceBackend {
  const live = liveOtelBackend(input.tracer, input.mapping);
  return {
    ...live,
    reserveActivation({ key, span, capture }) {
      const traceId = input.idGenerator.deriveTraceId(key);
      return {
        traceId,
        spanId: input.idGenerator.deriveSpanId(key),
        traceFlags:
          capture.emit &&
          input.samplesTrace(traceId, {
            name: input.mapping?.name?.(span, span.name) ?? span.name,
            attributes: mappedAttributes(input.mapping, span, span.attributes),
          })
            ? 1
            : 0,
      };
    },
    reserveChild: (parent, key) => ({
      ...parent,
      spanId: input.idGenerator.deriveSpanId(key),
      isRemote: false,
    }),
    startReserved(span, reference) {
      const writer = input.idGenerator.withTraceId(reference.traceId, () =>
        input.idGenerator.withSpanId(reference.spanId, () => live.start(span)),
      );
      if (
        writer.reference.spanId !== reference.spanId ||
        writer.reference.traceId !== reference.traceId
      ) {
        throw new Error("The tracer provider must use the durable backend's ID generator.");
      }
      return writer;
    },
  };
}
