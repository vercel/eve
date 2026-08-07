export interface SpanProcessor {
  forceFlush(): Promise<void>;
  onEnd(span: unknown): void;
  onStart(span: unknown, parentContext: unknown): void;
  shutdown(): Promise<void>;
}

export interface IdGenerator {
  generateSpanId(): string;
  generateTraceId(): string;
}

export interface Configuration {
  readonly autoDetectResources?: boolean;
  readonly idGenerator?: IdGenerator;
  readonly instrumentations?: readonly unknown[];
  readonly propagators?: readonly ["none"];
  readonly serviceName?: string;
  readonly spanProcessors?: readonly SpanProcessor[];
}

export declare function registerOTel(configuration?: Configuration | string): void;
