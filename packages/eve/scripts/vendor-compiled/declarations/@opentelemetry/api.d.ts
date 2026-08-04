export interface SpanContext {
  isRemote?: boolean;
  spanId: string;
  traceFlags: number;
  traceId: string;
  traceState?: unknown;
}

export interface Span {
  addEvent(name: string, attributes?: Attributes): this;
  end(): void;
  recordException(
    exception: Error | string | { message?: string; name?: string; stack?: string },
  ): void;
  setAttribute(key: string, value: AttributeValue): this;
  setStatus(status: { code: SpanStatusCode; message?: string | undefined }): this;
  spanContext(): SpanContext;
}

export interface Tracer {
  startSpan(
    name: string,
    options?: {
      attributes?: Attributes | undefined;
      kind?: SpanKind | undefined;
      root?: boolean | undefined;
    },
    context?: Context,
  ): Span;
}

export interface Context {}

export declare const ROOT_CONTEXT: Context;

export declare enum SpanStatusCode {
  UNSET = 0,
  OK = 1,
  ERROR = 2,
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

export declare const propagation: {
  extract<Carrier>(context: Context, carrier: Carrier, getter: TextMapGetter<Carrier>): Context;
};

export declare const trace: {
  getActiveSpan(): Span | undefined;
  getTracer(name: string, version?: string): Tracer;
  setSpan(context: Context, span: Span): Context;
  wrapSpanContext(spanContext: SpanContext): Span;
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
