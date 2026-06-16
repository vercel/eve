export interface SpanContext {
  spanId: string;
  traceFlags: number;
  traceId: string;
  traceState?: unknown;
}

export interface Span {
  addEvent(name: string, attributes?: Record<string, unknown>): this;
  end(): void;
  recordException(exception: unknown): void;
  setAttribute(key: string, value: unknown): this;
  setStatus(status: { code: SpanStatusCode; message?: string | undefined }): this;
  spanContext(): SpanContext;
}

export interface Tracer {
  startSpan(name: string, options?: { attributes?: Record<string, unknown> | undefined }): Span;
}

export interface Context {}

export declare enum SpanStatusCode {
  UNSET = 0,
  OK = 1,
  ERROR = 2,
}

export declare const context: {
  active(): Context;
  with<T>(context: Context, fn: () => T): T;
};

export declare const trace: {
  getActiveSpan(): Span | undefined;
  getTracer(name: string): Tracer;
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
