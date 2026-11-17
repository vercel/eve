export type AttributeValue =
  | string
  | number
  | boolean
  | (string | null | undefined)[]
  | (number | null | undefined)[]
  | (boolean | null | undefined)[];
/** Span attributes keyed by name. Entries with an `undefined` value are not recorded. */
export type Attributes = Readonly<Record<string, AttributeValue | undefined>>;
export type TraceJson =
  | null
  | boolean
  | number
  | string
  | readonly TraceJson[]
  | { readonly [key: string]: TraceJson };
declare const traceSnapshotBrand: unique symbol;
/** A JSON snapshot of an operation's trace state, as stored by a {@link TraceCheckpointer}. */
export type TraceSnapshot = TraceJson & { readonly [traceSnapshotBrand]: true };
export type SpanType =
  | "activation"
  | "step"
  | "model"
  | "tool"
  | "approval"
  | "memory"
  | "decision"
  | "channelRequest"
  | "mcp";
export type SpanKind = "INTERNAL" | "CLIENT" | "SERVER" | "PRODUCER" | "CONSUMER";

/** Host-owned process-local context. Never stored in a checkpoint. */
export type ExecutionContext = object;

/** Identifies a span: its trace ID, span ID, trace flags, and optional trace state, as in W3C trace context. */
export interface TraceReference {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly isRemote?: boolean;
  readonly tracestate?: string;
}

/** Whether an operation emits spans and whether it records input and output content. Child operations cannot exceed their parent's decision. */
export interface CaptureDecision {
  readonly emit: boolean;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}

/** Where a tracing failure happened: the phase, and the operation type and span when known. */
export interface TraceErrorContext {
  readonly phase: "start" | "serialize" | "complete" | "context" | "restore" | "checkpoint";
  readonly operation?: SpanType;
  readonly reference?: TraceReference;
}
/** Receives tracing failures with their context. Tracing errors are reported here instead of being thrown into the traced work. */
export type TraceErrorHandler = (error: unknown, context: TraceErrorContext) => void;

/** A link from a span to another span, with the relationship it records. */
export interface TraceLink {
  readonly context: TraceReference;
  readonly relationship: string;
}

/** A span ready for an {@link AgentTelemetry} backend to start: its name, kind, attributes, parent, links, and start time. */
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

/** A started span that an {@link AgentTelemetry} backend returns for recording attributes, events, errors, and status before it ends. */
export interface SpanWriter {
  readonly reference: TraceReference;
  setAttribute(key: string, value: AttributeValue): void;
  addEvent(name: string, attributes?: Attributes, timeMs?: number): void;
  fail(error?: unknown, errorType?: string): void;
  setStatus(code: "UNSET" | "OK" | "ERROR"): void;
  end(timeMs?: number): void;
}

/** Span output and context propagation used by agent tracing. */
export interface AgentTelemetry {
  /** Starts a span. A `reference` requests that exact trace and span ID. */
  startSpan(
    span: PreparedSpan,
    options?: { readonly reference?: TraceReference; readonly context?: ExecutionContext },
  ): SpanWriter;
  /** Returns the operation active in the current execution context. */
  active(): ActiveOperation | undefined;
  /**
   * Returns the span active in `context`, or the current execution context, including spans
   * the host started itself. Lets a decision nest under the host's span inside an operation.
   */
  activeSpan?(context?: ExecutionContext): TraceReference | undefined;
  /** Runs `execute` with `operation` as the active trace context. */
  run<T>(operation: ActiveOperation, execute: () => T, context?: ExecutionContext): T;
  /** Runs `execute` without creating spans. */
  suppressed?<T>(execute: () => T): T;
  /** Decides whether a durable turn's trace is recorded. Defaults to recording. */
  samples?(traceId: string, span: PreparedSpan): boolean;
  /** Derives stable IDs from keys. Present only when `startSpan` honors `reference`. */
  readonly ids?: {
    traceId(key: string): string;
    spanId(key: string): string;
  };
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Durable storage for in-flight turns. Values are JSON; keys are chosen by the library. */
export interface TraceCheckpointer {
  get(key: string): unknown | PromiseLike<unknown>;
  set(key: string, value: TraceSnapshot): void | PromiseLike<void>;
  delete(key: string): void | PromiseLike<void>;
}

/** The agent tracing operation active in an execution context, with its span reference, capture decision, and optional MCP and memory recorders. */
export interface ActiveOperation {
  readonly type: SpanType;
  readonly reference: TraceReference;
  readonly capture: CaptureDecision;
  readonly mcp?: import("./mcp.js").McpLifecycle;
  readonly memory?: import("./memory.js").MemoryToolLifecycle;
}

/** The operation an {@link OutputMapping} is mapping attributes for. */
export interface MappingContext {
  readonly type: SpanType;
  readonly operationId: string;
}

/** Rewrites span attributes and link attributes before they are written, for example to add backend-specific attributes. */
export interface OutputMapping {
  attributes(span: MappingContext, attributes: Attributes): Attributes;
  link(span: MappingContext, link: TraceLink): Attributes;
}

export interface RunIdentity {
  readonly conversationId: string;
  readonly runId: string;
  readonly turnId: string;
}

export interface FrameworkIdentity {
  readonly name: string;
  readonly version?: string;
}

/** Cost and token usage of a model call or operation. */
export interface Usage {
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly inputTokenDetails?: {
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
}

/** `subagent-call` and `remote-agent-call` delegate to another agent. */
export type ToolKind = string;
/** Capped GenAI input messages and how many of the oldest were dropped to fit. */
export interface InputMessagesContent {
  readonly json: string;
  readonly omitted: number;
}
/** Serializes captured payloads such as messages, instructions, tool definitions, and tool results into span attribute strings, returning `undefined` to omit one. */
export interface ContentSerializer {
  json(value: unknown): string | undefined;
  text(value: string): string | undefined;
  inputMessages(value: unknown): InputMessagesContent | undefined;
  instructions(value: unknown): string | undefined;
  toolDefinitions(value: unknown): string | undefined;
  outputMessages(value: readonly ContentPart[], finishReason: string): string | undefined;
  toolResults(value: readonly Record<string, unknown>[]): string | undefined;
}
export interface ModelResult {
  readonly usage: Usage;
  readonly responseId?: string;
  readonly responseModelId?: string;
  readonly finishReason: string;
  readonly content?: readonly ContentPart[];
}
export interface ScopeIdentity extends RunIdentity {
  readonly agentName?: string;
  readonly framework?: FrameworkIdentity;
}
export interface TurnMetadata {
  readonly attributes?: Attributes;
  readonly sequence: number;
  readonly subagent?: boolean;
  readonly subagentName?: string;
  readonly parentCallId?: string;
  readonly parentRunId?: string;
  readonly channel?: { kind?: string; origin?: string };
}
export interface StepOptions {
  readonly index: number;
  readonly attempt?: number;
  readonly channel?: { kind?: string; origin?: string };
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
}
export interface ModelOptions {
  readonly provider: string;
  readonly modelId: string;
  readonly messages?: readonly unknown[];
  readonly instructions?: unknown;
  /** Tools offered to the model, recorded as `gen_ai.tool.definitions`. */
  readonly tools?: unknown;
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
}
export interface DecisionOptions {
  readonly provider?: string;
  readonly modelId: string;
  /** What the decision is for, such as `model-selection` or `tool-approval`. */
  readonly purpose?: string;
}
export interface ToolOptions {
  readonly callId: string;
  readonly name: string;
  readonly kind?: ToolKind;
  readonly arguments?: unknown;
}
/**
 * A wait on a person. Under a tool call it names that call; under a turn it has no call, such
 * as a budget prompt or a sign-in the turn needs before it can run.
 */
export interface ApprovalOptions {
  readonly requestId: string;
  readonly request?: unknown;
  /** What the person is asked, recorded as `agent.approval.kind`. Defaults to `tool-approval`. */
  readonly kind?: string;
  /** The connection a sign-in is for, recorded as `agent.connection.name`. */
  readonly connectionName?: string;
  readonly callId?: string;
  readonly toolName?: string;
}
export type ScopeData =
  | { readonly type: "activation"; readonly options: TurnMetadata }
  | { readonly type: "step"; readonly options: StepOptions }
  | { readonly type: "model"; readonly options: ModelOptions }
  | { readonly type: "tool"; readonly options: ToolOptions }
  | { readonly type: "approval"; readonly options: ApprovalOptions }
  | { readonly type: "decision"; readonly options: DecisionOptions }
  | {
      readonly type: "memory";
      readonly options: {
        operation: "search_memory" | "upsert_memory";
        phase: string;
        slot: string;
        storeId: string;
      };
    };
export interface ScopeTerminal {
  readonly outcome?: string;
  /** Ends the operation without recording an outcome, when the host never learned one. */
  readonly outcomeUnknown?: boolean;
  readonly failed?: boolean;
  readonly error?: unknown;
  readonly errorCode?: string;
  readonly output?: unknown;
  readonly response?: unknown;
  readonly usage?: Usage;
  readonly model?: ModelResult;
  readonly recordCount?: number;
  readonly records?: readonly { id?: string; content: string }[];
  readonly endTimeMs?: number;
}
export interface ScopeRecord {
  readonly version?: 1;
  readonly finished?: boolean;
  readonly revision?: string;
  readonly key: string;
  readonly identity: ScopeIdentity;
  readonly data: ScopeData;
  readonly reference: TraceReference;
  readonly parent?: TraceReference;
  readonly attempt?: { readonly index: number; readonly attempt: number };
  readonly capture: CaptureDecision;
  readonly startTimeMs: number;
  readonly links?: readonly TraceLink[];
  readonly usage?: Usage;
  readonly usageKeys?: readonly string[];
  readonly attributes?: Attributes;
  readonly childSequence?: number;
  readonly children?: readonly ScopeRecord[];
  readonly terminal?: ScopeTerminal;
}
export interface Operation {
  child(data: ScopeData, key?: string): Promise<Operation>;
  waitUntil(completion: Promise<void>): void;
  readonly type: ScopeData["type"];
  readonly reference: TraceReference;
  readonly parent?: TraceReference;
  readonly startTimeMs: number;
  readonly capture: CaptureDecision;
  readonly finished: boolean;
  snapshot(): TraceSnapshot;
  run<T>(execute: () => T, ceiling?: CaptureDecision): T;
  attributes(attributes: Attributes): void;
  update(input: { attributes?: Attributes; links?: readonly TraceLink[] }): void;
  complete(result?: ScopeTerminal & { errorType?: string; result?: ModelResult }): Promise<void>;
  fail(error: unknown): Promise<void>;
  modelCall(input: ModelOptions, key?: string): Promise<Operation>;
}

/** One part of model output: text, reasoning, or a tool call, result, or error. */
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
