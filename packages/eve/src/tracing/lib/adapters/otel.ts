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
  type TracerProvider,
} from "@opentelemetry/api";
import { recordAgentSpanError } from "./otel-error.js";
import { AgentSpanIdGenerator } from "./otel-ids.js";
import type {
  Attributes,
  AgentTelemetry,
  OutputMapping,
  PreparedSpan,
  SpanWriter,
  TraceReference,
  ExecutionContext,
  ActiveOperation,
} from "../core/types.js";
import { activeOperation, intersectCapture } from "../core/activation.js";
import { withCapture } from "../capture.js";

type Context = OtelContext;
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

export interface OtelTelemetryOptions {
  /** Defaults to the global tracer provider. */
  readonly provider?: TracerProvider;
  /**
   * Generator installed on `provider`. Required for durable tracing so a span
   * started in a later process carries the ID its children already reference.
   */
  readonly idGenerator?: AgentSpanIdGenerator;
  /** Defaults to recording every trace. */
  readonly samplesTrace?: (
    traceId: string,
    operation: { name: string; attributes: Attributes },
  ) => boolean;
  readonly mapping?: OutputMapping;
  readonly tracerName?: string;
  /** Override the provider's lifecycle, for example to flush metric readers too. */
  readonly forceFlush?: () => Promise<void>;
  readonly shutdown?: () => Promise<void>;
}

/** OpenTelemetry implementation of {@link AgentTelemetry}. */
export function otelTelemetry(options: OtelTelemetryOptions = {}): AgentTelemetry {
  const provider = options.provider ?? trace.getTracerProvider();
  const tracer = provider.getTracer(options.tracerName ?? "agent.tracing");
  const mapping = options.mapping;
  const idGenerator = options.idGenerator;
  function lifecycle(method: "forceFlush" | "shutdown"): () => Promise<void> {
    return (
      options[method] ??
      (async () => {
        const callback = (
          provider as TracerProvider & { forceFlush?(): Promise<void>; shutdown?(): Promise<void> }
        )[method];
        if (callback === undefined)
          throw new Error(`The tracer provider does not support ${method}.`);
        await callback.call(provider);
      })
    );
  }
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
    startSpan(span, { reference, context: host } = {}) {
      if (reference === undefined || idGenerator === undefined) return start(span, host);
      const writer = idGenerator.withTraceId(reference.traceId, () =>
        idGenerator.withSpanId(reference.spanId, () => start(span, host)),
      );
      if (
        writer.reference.spanId !== reference.spanId ||
        writer.reference.traceId !== reference.traceId
      ) {
        throw new Error("The tracer provider must use the telemetry's ID generator.");
      }
      return writer;
    },
    active: () => activeTraceOperation(),
    suppressed<T>(execute: () => T): T {
      return context.with(withErrorContent(suppressTracing(ROOT_CONTEXT), false), execute);
    },
    run(operation, execute, executionContext) {
      let capture = intersectCapture(operation.capture, activeTraceOperation()?.capture);
      // Retain baggage and host context while replacing the semantic parent span.
      let active = trace.setSpan(
        (executionContext as Context | undefined) ?? context.active(),
        trace.wrapSpanContext(otelReference(operation.reference)),
      );
      capture = intersectCapture(
        capture,
        (active.getValue(ACTIVE_OPERATION) as ActiveOperation | undefined)?.capture,
      );
      active = active.setValue(ACTIVE_OPERATION, activeOperation(operation, capture));
      active = withCapture(active, capture);
      if (!capture.emit || (operation.reference.traceFlags & 1) === 0)
        active = suppressTracing(active);
      return context.with(active, execute);
    },
    samples: (traceId, span) =>
      options.samplesTrace?.(traceId, {
        name: span.name,
        attributes: mappedAttributes(mapping, span, span.attributes),
      }) ?? true,
    ids:
      idGenerator === undefined
        ? undefined
        : {
            traceId: (key) => idGenerator.deriveTraceId(key),
            spanId: (key) => idGenerator.deriveSpanId(key),
          },
    forceFlush: lifecycle("forceFlush"),
    shutdown: lifecycle("shutdown"),
  };
}
