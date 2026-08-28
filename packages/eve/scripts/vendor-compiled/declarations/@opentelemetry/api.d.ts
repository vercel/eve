export interface TraceState {
  get(key: string): string | undefined;
  serialize(): string;
  set(key: string, value: string): TraceState;
  unset(key: string): TraceState;
}

export interface SpanContext {
  isRemote?: boolean;
  spanId: string;
  traceFlags: number;
  traceId: string;
  traceState?: TraceState;
}

export interface Span {
  addEvent(name: string, attributes?: Attributes, timestamp?: number): this;
  end(endTime?: number): void;
  recordException(
    exception: Error | string | { message?: string; name?: string; stack?: string },
  ): void;
  setAttribute(key: string, value: AttributeValue): this;
  setStatus(status: { code: SpanStatusCode; message?: string | undefined }): this;
  spanContext(): SpanContext;
}

export interface Link {
  context: SpanContext;
  attributes?: Attributes;
}

export interface Tracer {
  startSpan(
    name: string,
    options?: {
      attributes?: Attributes | undefined;
      kind?: SpanKind | undefined;
      links?: Link[] | undefined;
      root?: boolean | undefined;
      startTime?: number | undefined;
    },
    context?: Context,
  ): Span;
}

export interface Context {
  setValue(key: symbol, value: unknown): Context;
}

export declare function createContextKey(description: string): symbol;

export declare const ROOT_CONTEXT: Context;

export declare enum SpanStatusCode {
  UNSET = 0,
  OK = 1,
  ERROR = 2,
}

export declare enum TraceFlags {
  NONE = 0,
  SAMPLED = 1,
}

export declare const context: {
  active(): Context;
  with<T>(context: Context, fn: () => T): T;
};

/**
 * Reads carrier values during context extraction. `Carrier` is the
 * transport-specific container (e.g. a `Headers` instance for inbound
 * HTTP requests).
 */
export interface TextMapGetter<Carrier = unknown> {
  get(carrier: Carrier, key: string): string | string[] | undefined;
  keys(carrier: Carrier): string[];
}

export interface TextMapSetter<Carrier = unknown> {
  set(carrier: Carrier, key: string, value: string): void;
}

export declare const propagation: {
  extract<Carrier>(context: Context, carrier: Carrier, getter: TextMapGetter<Carrier>): Context;
  inject<Carrier>(context: Context, carrier: Carrier, setter: TextMapSetter<Carrier>): void;
};

export declare const trace: {
  deleteSpan(context: Context): Context;
  getActiveSpan(): Span | undefined;
  getSpan(context: Context): Span | undefined;
  getTracer(name: string, version?: string): Tracer;
  getTracerProvider(): unknown;
  setSpan(context: Context, span: Span): Context;
  wrapSpanContext(spanContext: SpanContext): Span;
};

export interface MetricOptions {
  readonly description?: string;
  readonly unit?: string;
}

export interface ObservableResult {
  observe(value: number, attributes?: Attributes): void;
}

export interface Counter {
  add(value: number, attributes?: Attributes): void;
}

export interface Histogram {
  record(value: number, attributes?: Attributes): void;
}

export interface ObservableGauge {
  addCallback(callback: (result: ObservableResult) => void): void;
}

export interface ObservableUpDownCounter {
  addCallback(callback: (result: ObservableResult) => void): void;
}

export interface Meter {
  createCounter(name: string, options?: MetricOptions): Counter;
  createHistogram(name: string, options?: MetricOptions): Histogram;
  createObservableGauge(name: string, options?: MetricOptions): ObservableGauge;
  createObservableUpDownCounter(name: string, options?: MetricOptions): ObservableUpDownCounter;
}

export declare const metrics: {
  getMeter(name: string, version?: string): Meter;
};

export declare enum SpanKind {
  INTERNAL = 0,
  SERVER = 1,
  CLIENT = 2,
  PRODUCER = 3,
  CONSUMER = 4,
}
export type AttributeValue =
  | string
  | number
  | boolean
  | Array<string | null | undefined>
  | Array<number | null | undefined>
  | Array<boolean | null | undefined>;

export type Attributes = Record<string, AttributeValue | undefined>;
