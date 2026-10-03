import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  createTraceState,
  createContextKey,
  type SpanContext,
  type Context as OtelContext,
  type Tracer as OtelTracer,
} from "@opentelemetry/api";
import { recordAgentSpanError } from "./otel-error.js";
import type { AgentSpanIdGenerator } from "./otel-ids.js";
import type {
  Attributes,
  TraceBackend,
  OutputMapping,
  PreparedSpan,
  SpanWriter,
  TraceReference,
  ExecutionContext,
  ActiveOperation,
} from "#tracing/lib/index.js";
import { activeOperation, intersectCapture, withCapture } from "#tracing/lib/index.js";

type Context = OtelContext;
type Tracer = Pick<OtelTracer, "startSpan">;
const ACTIVE_OPERATION = createContextKey("agent.tracing.active-operation");
const SUPPRESS_TRACING_KEY = createContextKey("OpenTelemetry SDK Context Key SUPPRESS_TRACING");

export function withErrorContent<T extends { setValue(key: symbol, value: unknown): T }>(
  context: T,
  allowed: boolean,
): T {
  return withCapture(context, { emit: true, recordInputs: allowed, recordOutputs: allowed });
}

function suppressTracing(context: Context): Context {
  return context.setValue(SUPPRESS_TRACING_KEY, true);
}

export function activeTraceOperation(
  host: Pick<Context, "getValue"> = context.active(),
): ActiveOperation | undefined {
  return typeof host.getValue === "function"
    ? (host.getValue(ACTIVE_OPERATION) as ActiveOperation | undefined)
    : undefined;
}

function parentContext(reference: TraceReference | undefined, host?: ExecutionContext): Context {
  const base = (host as Context | undefined) ?? ROOT_CONTEXT;
  return reference === undefined
    ? base
    : trace.setSpan(base, trace.wrapSpanContext(otelReference(reference)));
}

function otelReference(reference: TraceReference): SpanContext {
  return {
    ...reference,
    traceState:
      reference.tracestate === undefined ? undefined : createTraceState(reference.tracestate),
  };
}

function portableReference(reference: SpanContext): TraceReference {
  return {
    traceId: reference.traceId,
    spanId: reference.spanId,
    traceFlags: reference.traceFlags,
    isRemote: reference.isRemote,
    tracestate: reference.traceState?.serialize(),
  };
}

function mappedAttributes(
  mapping: OutputMapping | undefined,
  span: PreparedSpan,
  attributes: Attributes,
): Attributes {
  return mapping?.attributes(span, attributes) ?? attributes;
}

export function liveOtelBackend(
  tracer: Tracer,
  mapping?: OutputMapping,
): Pick<TraceBackend, "start" | "run" | "current" | "active" | "suppressed"> {
  function start(span: PreparedSpan, executionContext?: ExecutionContext): SpanWriter {
    const recorded = tracer.startSpan(
      span.name,
      {
        attributes: mappedAttributes(mapping, span, span.attributes),
        kind: span.kind === undefined ? undefined : SpanKind[span.kind],
        root: span.root,
        startTime: span.startTimeMs,
        links: span.links?.map((link) => ({
          context: otelReference(link.context),
          attributes: mapping?.link(span, link) ?? { "agent.link.type": link.relationship },
        })),
      },
      parentContext(span.root ? undefined : span.parent, executionContext),
    );
    return {
      reference: portableReference(recorded.spanContext()),
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
    current: () => {
      const active = trace.getSpan(context.active())?.spanContext();
      return active === undefined ? undefined : portableReference(active);
    },
    active: () => activeTraceOperation(),
    suppressed<T>(execute: () => T): T {
      return context.with(withErrorContent(suppressTracing(ROOT_CONTEXT), false), execute);
    },
    run(reference, capture, execute, executionContext, operation) {
      capture = intersectCapture(capture, activeTraceOperation()?.capture);
      // Retain baggage and host context while replacing the semantic parent span.
      let active = trace.setSpan(
        (executionContext as Context | undefined) ?? context.active(),
        trace.wrapSpanContext(otelReference(reference)),
      );
      capture = intersectCapture(
        capture,
        (active.getValue(ACTIVE_OPERATION) as ActiveOperation | undefined)?.capture,
      );
      active = active.setValue(
        ACTIVE_OPERATION,
        activeOperation(operation ?? { type: "activation", reference, capture }, capture),
      );
      active = withCapture(active, capture);
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
}): TraceBackend {
  const live = liveOtelBackend(input.tracer, input.mapping);
  return {
    ...live,
    reserveReference({ key, parent, traceFlags }) {
      return {
        ...parent,
        traceId: parent?.traceId ?? input.idGenerator.deriveTraceId(key),
        spanId: input.idGenerator.deriveSpanId(key),
        traceFlags,
        isRemote: false,
      };
    },
    admits(span, reference) {
      return input.samplesTrace(reference.traceId, {
        name: span.name,
        attributes: mappedAttributes(input.mapping, span, span.attributes),
      });
    },
    reserveActivation({ key, span, capture }) {
      const traceId = input.idGenerator.deriveTraceId(key);
      return {
        traceId,
        spanId: input.idGenerator.deriveSpanId(key),
        traceFlags:
          capture.emit &&
          input.samplesTrace(traceId, {
            name: span.name,
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
    startReserved(span, reference, executionContext) {
      const writer = input.idGenerator.withTraceId(reference.traceId, () =>
        input.idGenerator.withSpanId(reference.spanId, () => live.start(span, executionContext)),
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
