export interface SpanProcessor {
  forceFlush(): Promise<void>;
  onEnd(span: unknown): void;
  onStart(span: unknown, parentContext: unknown): void;
  shutdown(): Promise<void>;
}

export type SpanProcessorOrName = SpanProcessor | "auto";

export interface IdGenerator {
  generateSpanId(): string;
  generateTraceId(): string;
}

/**
 * A `SpanExporter`. Structural for the same reason the propagator is: the
 * instance comes from whichever `@opentelemetry/*` build the app installed, and
 * eve only ever hands it spans and waits for the callback.
 *
 * `code` is `ExportResultCode`: `0` succeeded, `1` failed.
 */
export interface SpanExporter {
  export(
    spans: readonly unknown[],
    resultCallback: (result: { code: number; error?: Error }) => void,
  ): void;
  forceFlush?(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * A `TextMapPropagator`, or one of the names `@vercel/otel` resolves for you.
 * Structural rather than imported: the instance comes from whichever
 * `@opentelemetry/*` build the app installed, not from eve's.
 */
export type PropagatorOrName =
  | { inject(...args: never[]): void; extract(...args: never[]): unknown; fields(): string[] }
  | "auto"
  | "none"
  | "tracecontext"
  | "baggage";

/** A `Sampler`, or one of the names `@vercel/otel` resolves for you. */
export type SamplerOrName =
  | { shouldSample(...args: never[]): unknown; toString(): string }
  | "auto"
  | "always_off"
  | "always_on"
  | "parentbased_always_off"
  | "parentbased_always_on"
  | "parentbased_traceidratio"
  | "traceidratio";

/**
 * A `MetricReader`. Structural for the same reason the exporter is: the
 * instance comes from whichever `@opentelemetry/sdk-metrics` build the app
 * installed, and eve only ever hands it to `registerOTel`.
 */
export interface MetricReader {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface Configuration {
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly autoDetectResources?: boolean;
  readonly idGenerator?: IdGenerator;
  readonly instrumentations?: readonly unknown[];
  readonly metricReaders?: readonly MetricReader[];
  readonly propagators?: readonly PropagatorOrName[];
  readonly serviceName?: string;
  readonly spanProcessors?: readonly SpanProcessorOrName[];
  readonly traceSampler?: SamplerOrName;
}

export declare function registerOTel(configuration?: Configuration | string): void;
