import { createRequire } from "node:module";

import { context, propagation, trace, type Context } from "#compiled/@opentelemetry/api/index.js";
import {
  registerOTel,
  type Configuration,
  type SpanProcessor,
  type SpanProcessorOrName,
} from "#compiled/@vercel/otel/index.js";

import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { OtelPipeline } from "#tracing/otel-declaration.js";

const REGISTRATION_SPAN_NAME = "eve.otel.registration";
const REPLAY_DEDUPLICATION_LIMIT = 100_000;
const require = createRequire(import.meta.url);

class RegistrationMarkerPropagator {
  #injected = false;

  extract(carrierContext: Context): Context {
    return carrierContext;
  }

  fields(): string[] {
    return [];
  }

  inject(): void {
    this.#injected = true;
  }

  isInstalled(): boolean {
    this.#injected = false;
    propagation.inject(context.active(), {}, { set: () => {} });
    return this.#injected;
  }
}

/** Keeps eve's ownership check out of every authored destination. */
class PrivateSpanFilteringProcessor implements SpanProcessor {
  private readonly endedSpans = new Set<string>();
  private readonly forwardedSpans = new Set<string>();
  private readonly pendingByParent = new Map<string, unknown[]>();
  private readonly processors: readonly SpanProcessor[];
  private readonly startedSpans = new Set<string>();

  constructor(processors: readonly SpanProcessor[]) {
    this.processors = processors;
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.processors.map((processor) => processor.forceFlush()));
  }

  onEnd(span: unknown): void {
    if (isRegistrationSpan(span)) return;
    const identity = spanIdentity(span);
    if (identity !== undefined) {
      if (this.endedSpans.has(identity)) return;
      if (this.endedSpans.size >= REPLAY_DEDUPLICATION_LIMIT) {
        const oldest = this.endedSpans.values().next().value;
        if (oldest !== undefined) this.endedSpans.delete(oldest);
      }
      this.endedSpans.add(identity);
    }
    const parent = parentIdentity(span);
    if (parent !== undefined && this.startedSpans.has(parent) && !this.forwardedSpans.has(parent)) {
      const pending = this.pendingByParent.get(parent) ?? [];
      pending.push(span);
      this.pendingByParent.set(parent, pending);
      return;
    }
    this.forward(span, identity);
  }

  onStart(span: unknown, parentContext: unknown): void {
    if (isRegistrationSpan(span)) return;
    const identity = spanIdentity(span);
    if (identity !== undefined) addBounded(this.startedSpans, identity);
    for (const processor of this.processors) processor.onStart(span, parentContext);
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.processors.map((processor) => processor.shutdown()));
  }

  private forward(span: unknown, identity: string | undefined): void {
    for (const processor of this.processors) processor.onEnd(span);
    if (identity === undefined) return;
    addBounded(this.forwardedSpans, identity);
    const children = this.pendingByParent.get(identity);
    if (children === undefined) return;
    this.pendingByParent.delete(identity);
    for (const child of children) this.forward(child, spanIdentity(child));
  }
}

/**
 * Builds the process's one OpenTelemetry tracer provider from a merged
 * declaration, then proves it took the global slot.
 *
 * `registerOTel` reports a refused registration only through `diag`, which
 * goes nowhere unless `OTEL_LOG_LEVEL` is set, so a second caller would export
 * nothing and say nothing. eve primes its id generator and installs a private
 * propagator, then verifies both through the global APIs.
 */
export function registerOtelPipeline(input: {
  readonly pipeline: OtelPipeline;
  readonly serviceName: string;
}): RegisteredOtelPipeline {
  const { pipeline } = input;
  // A tracer cached before registration retains this private proxy even after
  // the vendored API takes the global slot. Delegate it only after ownership is proven.
  const optionalPeerTracerProxy = captureOptionalPeerTracerProxy();
  const idGenerator = new AgentSpanIdGenerator();
  const markerPropagator = new RegistrationMarkerPropagator();
  const configuration: Configuration = {
    attributes: pipeline.resource,
    autoDetectResources: false,
    idGenerator,
    instrumentations: pipeline.instrumentations ?? [],
    metricReaders: pipeline.metricReaders,
    propagators: [...(pipeline.propagators ?? ["auto"]), markerPropagator],
    serviceName: input.serviceName,
    spanProcessors: pipeline.spanProcessors.map((processor) =>
      isSpanProcessor(processor) ? new PrivateSpanFilteringProcessor([processor]) : processor,
    ),
  };
  registerOTel(
    // Absent means "let `@vercel/otel` decide", which is not the same as
    // passing an explicit `undefined` sampler.
    pipeline.sampler === undefined
      ? configuration
      : { ...configuration, traceSampler: pipeline.sampler },
  );

  const ownsTracer = globalTracerUses(idGenerator);
  const ownsPropagator = markerPropagator.isInstalled();
  if (!ownsTracer || !ownsPropagator) {
    rollbackRegistration({ ownsPropagator, ownsTracer });
  }
  if (!ownsTracer) {
    throw new Error(
      "eve could not register OpenTelemetry because another runtime already owns the global tracer provider. Remove the other `registerOTel` call, or move its exporters into eve's `otelIntegration({ spanProcessors: [...] })`.",
    );
  }
  if (!ownsPropagator) {
    throw new Error(
      "eve could not register OpenTelemetry because another runtime already owns the global propagator. Remove the other global propagator registration and declare propagators through eve's `otel()` instead.",
    );
  }
  const provider = runtimeTracerProvider();
  if (typeof provider.forceFlush !== "function" || typeof provider.shutdown !== "function") {
    rollbackRegistration({ ownsPropagator, ownsTracer });
    throw new Error("The registered OpenTelemetry tracer provider has no lifecycle methods.");
  }
  optionalPeerTracerProxy?.setDelegate(provider);
  return {
    forceFlush: () => provider.forceFlush!(),
    idGenerator,
    samplesTrace: (traceId) => samplerAdmitsTrace(idGenerator, traceId),
    shutdown: () => provider.shutdown!(),
  };
}

/** Lifecycle retained from the tracer provider that owns every destination. */
export interface RegisteredOtelPipeline {
  readonly forceFlush: () => Promise<void>;
  readonly idGenerator: AgentSpanIdGenerator;
  /** Whether the installed sampler would record a trace with this id. */
  readonly samplesTrace: (traceId: string) => boolean;
  readonly shutdown: () => Promise<void>;
}

function samplerAdmitsTrace(idGenerator: AgentSpanIdGenerator, traceId: string): boolean {
  const probe = idGenerator.withTraceId(traceId, () =>
    trace.getTracer("eve.registration").startSpan(REGISTRATION_SPAN_NAME, { root: true }),
  );
  return (probe.spanContext().traceFlags & 1) === 1;
}

interface RuntimeTracerProvider {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

interface ProxyTracerProvider {
  getDelegate(): unknown;
}

interface OptionalPeerTracerProxy {
  setDelegate(delegate: unknown): void;
}

function captureOptionalPeerTracerProxy(): OptionalPeerTracerProxy | undefined {
  try {
    const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
    const provider = api.trace.getTracerProvider();
    return provider instanceof api.ProxyTracerProvider ? provider : undefined;
  } catch {
    return undefined;
  }
}

function rollbackRegistration(input: {
  readonly ownsPropagator: boolean;
  readonly ownsTracer: boolean;
}): void {
  if (input.ownsPropagator) {
    (propagation as typeof propagation & { disable(): void }).disable();
  }
  if (!input.ownsTracer) return;
  const provider = runtimeTracerProvider();
  if (typeof provider.shutdown === "function") {
    try {
      void provider.shutdown().catch(() => {});
    } catch {}
  }
  (trace as typeof trace & { disable(): void }).disable();
}

function runtimeTracerProvider(): Partial<RuntimeTracerProvider> {
  const globalProvider = trace.getTracerProvider() as Partial<ProxyTracerProvider>;
  return (globalProvider.getDelegate?.() ?? globalProvider) as Partial<RuntimeTracerProvider>;
}

function globalTracerUses(idGenerator: AgentSpanIdGenerator): boolean {
  const spanId = idGenerator.allocateSpanId();
  const probe = idGenerator.withSpanId(spanId, () =>
    trace.getTracer("eve.registration").startSpan(REGISTRATION_SPAN_NAME),
  );
  // Deliberately not ended: named processors are resolved inside @vercel/otel
  // and cannot be wrapped, while an unended span is never exported.
  return probe.spanContext().spanId === spanId;
}

function isRegistrationSpan(span: unknown): boolean {
  return (
    typeof span === "object" &&
    span !== null &&
    "name" in span &&
    span.name === REGISTRATION_SPAN_NAME
  );
}

function spanIdentity(span: unknown): string | undefined {
  if (
    typeof span !== "object" ||
    span === null ||
    !("spanContext" in span) ||
    typeof span.spanContext !== "function"
  ) {
    return undefined;
  }
  const context = span.spanContext() as { readonly spanId?: unknown; readonly traceId?: unknown };
  return typeof context.traceId === "string" && typeof context.spanId === "string"
    ? `${context.traceId}:${context.spanId}`
    : undefined;
}

function parentIdentity(span: unknown): string | undefined {
  if (typeof span !== "object" || span === null || !("parentSpanContext" in span)) {
    return undefined;
  }
  const parent = span.parentSpanContext as
    | { readonly spanId?: unknown; readonly traceId?: unknown }
    | undefined;
  return typeof parent?.traceId === "string" && typeof parent.spanId === "string"
    ? `${parent.traceId}:${parent.spanId}`
    : undefined;
}

function addBounded(values: Set<string>, value: string): void {
  if (values.size >= REPLAY_DEDUPLICATION_LIMIT) {
    const oldest = values.values().next().value;
    if (oldest !== undefined) values.delete(oldest);
  }
  values.add(value);
}

function isSpanProcessor(processor: SpanProcessorOrName): processor is SpanProcessor {
  return processor !== "auto";
}
