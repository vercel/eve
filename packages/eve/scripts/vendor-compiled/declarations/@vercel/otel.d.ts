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

export interface SpanExporter {
  export(
    spans: readonly unknown[],
    resultCallback: (result: { code: number; error?: Error }) => void,
  ): void;
  forceFlush?(): Promise<void>;
  shutdown(): Promise<void>;
}

export type PropagatorOrName =
  | { inject(...args: never[]): void; extract(...args: never[]): unknown; fields(): string[] }
  | "auto"
  | "none"
  | "tracecontext"
  | "baggage";

export type SamplerOrName =
  | { shouldSample(...args: never[]): unknown; toString(): string }
  | "auto"
  | "always_off"
  | "always_on"
  | "parentbased_always_off"
  | "parentbased_always_on"
  | "parentbased_traceidratio"
  | "traceidratio";

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
