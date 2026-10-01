export type AttributeValue =
  | string
  | number
  | boolean
  | (string | null | undefined)[]
  | (number | null | undefined)[]
  | (boolean | null | undefined)[];
export type Attributes = Readonly<Record<string, AttributeValue | undefined>>;
export type SpanType =
  | "activation"
  | "step"
  | "model"
  | "action"
  | "tool"
  | "approval"
  | "memory"
  | "channelRequest"
  | "mcp";
export type SpanKind = "INTERNAL" | "CLIENT" | "SERVER";

export interface TraceReference {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly isRemote?: boolean;
}

export interface CaptureDecision {
  readonly emit: boolean;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}

export interface TraceLink {
  readonly context: TraceReference;
  readonly relationship: "agent.dispatch" | "channel.request" | "execution.delivery";
}

export interface PreparedSpan {
  readonly type: SpanType;
  readonly operationId: string;
  readonly name: string;
  readonly kind?: SpanKind;
  readonly attributes: Attributes;
  readonly parent?: TraceReference;
  readonly root?: boolean;
  readonly startTimeMs?: number;
  readonly links?: readonly TraceLink[];
}

export interface SpanWriter {
  readonly reference: TraceReference;
  setAttribute(key: string, value: AttributeValue): void;
  addEvent(name: string, attributes?: Attributes, timeMs?: number): void;
  fail(error?: unknown, errorType?: string): void;
  setStatus(code: "UNSET" | "OK" | "ERROR"): void;
  end(timeMs?: number): void;
}

export interface TraceBackend {
  start(span: PreparedSpan): SpanWriter;
  run<T>(reference: TraceReference, capture: CaptureDecision, execute: () => T): T;
  current(): TraceReference | undefined;
}

export interface DurableTraceBackend extends TraceBackend {
  reserveActivation(input: {
    key: string;
    span: PreparedSpan;
    capture: CaptureDecision;
  }): TraceReference;
  reserveChild(parent: TraceReference, key: string): TraceReference;
  startReserved(span: PreparedSpan, reference: TraceReference): SpanWriter;
}

export interface MappingContext {
  readonly type: SpanType;
  readonly operationId: string;
}

export interface OutputMapping {
  name?(span: MappingContext, name: string): string;
  attributes(span: MappingContext, attributes: Attributes): Attributes;
  link(
    span: MappingContext,
    link: TraceLink,
  ): { readonly context: TraceReference; readonly attributes: Attributes };
}

export interface RunIdentity {
  readonly conversationId: string;
  readonly runId: string;
  readonly turnId: string;
}

export interface FrameworkIdentity {
  readonly name: string;
  readonly version: string;
}

export interface Usage {
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly inputTokenDetails?: {
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
}

export type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool-result";
      readonly callId: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly output: unknown;
    }
  | {
      readonly type: "tool-error";
      readonly callId: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly error: unknown;
    };
