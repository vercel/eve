import { createInstrumentationDispatcher } from "#harness/instrumentation/dispatch.js";
import type { InstrumentationStateSlot } from "#harness/instrumentation/state.js";
import type { RuntimeTraceContext } from "#protocol/message.js";

/**
 * Stable eve identity for one actual model attempt.
 *
 * A step retried three times produces three of these, all sharing `stepIndex`
 * and separated by `attemptIndex` — which is why the events carrying this
 * scope are named `step.attempt.*` and not `step.*`. The protocol's `step.*`
 * and the `events["step.started"]` resolver hook fire once per step; these
 * fire once per attempt.
 */
export interface InstrumentationAttemptScope {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly functionId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly stepIndex: number;
  readonly turnId: string;
}

/** The model SDK operation an attempt runs through. */
export interface InstrumentationOperationRef {
  readonly modelId: string;
  readonly operationId: string;
  readonly provider: string;
}

export interface InstrumentationModelRef {
  readonly modelId: string;
  readonly provider: string;
}

/** Token usage for one model call. A field is absent when the provider omits it. */
export interface InstrumentationUsage {
  readonly inputTokenDetails?: {
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** Final model input for one call. Message shape stays opaque to this layer. */
export interface InstrumentationModelInput {
  readonly instructions?: unknown;
  readonly messages: readonly unknown[];
}

/**
 * The model response parts eve records. A kind outside this union is dropped
 * when the bridge maps a response, so widening the union is what makes a new
 * kind reachable by a provider.
 */
export type InstrumentationContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly input: unknown;
      readonly toolName: string;
    }
  | {
      readonly type: "tool-result";
      readonly callId: string;
      readonly input: unknown;
      readonly output: unknown;
      readonly toolName: string;
    }
  | {
      readonly type: "tool-error";
      readonly callId: string;
      readonly error: unknown;
      readonly input: unknown;
      readonly toolName: string;
    };

/**
 * What eve dispatched an action as. The model sees every action as a tool, so
 * this is the only thing that separates a subagent or remote-agent call from an
 * ordinary tool in a trace.
 */
export type InstrumentationActionKind =
  | "load-skill"
  | "remote-agent-call"
  | "subagent-call"
  | "tool-call";

/**
 * How one action ended.
 *
 * `type` survives a provider that declined content, so whether the tool errored
 * is answerable without seeing what it returned.
 */
export type InstrumentationActionOutput =
  | { readonly type: "result"; readonly output?: unknown }
  | { readonly type: "error"; readonly error?: unknown };

/**
 * How much of an event a provider is handed.
 *
 * `"metadata"` — the default — is structure, identity, usage, and timing: every
 * field except what the conversation actually said. `"content"` adds the
 * prompt, the response, tool arguments, and tool results.
 *
 * Declared per provider rather than per process, because two consumers of one
 * bus rarely have the same retention path. Content is built at all only when
 * some provider asked for it, and a provider that did not ask never receives
 * it — which is the same guarantee a destination that declines content gets,
 * one layer lower and without an OpenTelemetry pipeline to route it through.
 */
export type InstrumentationCapture = "content" | "metadata";

/**
 * Every event carries an `idempotencyKey` naming the operation it is about: a
 * start and its terminal share one, and two operations never collide.
 *
 * Every part is identity eve reconstructs on replay — session and turn ids,
 * `scope.attemptId` (itself `session:turn:step:attempt`), AI SDK step number,
 * and durable runtime-action call ids. A provider writing rows can use the key
 * as its row id and be idempotent by construction.
 */
export function sessionIdempotencyKey(sessionId: string): string {
  return `session:${sessionId}`;
}

export function turnIdempotencyKey(sessionId: string, turnId: string): string {
  return `turn:${sessionId}:${turnId}`;
}

export function attemptIdempotencyKey(scope: InstrumentationAttemptScope): string {
  return `step:${scope.attemptId}`;
}

/** One model call occurs per AI SDK step within an eve attempt. */
export function modelCallIdempotencyKey(
  scope: InstrumentationAttemptScope,
  stepNumber: number,
): string {
  return `model:${scope.attemptId}:${String(stepNumber)}`;
}

export function toolCallIdempotencyKey(
  scope: InstrumentationAttemptScope,
  callId: string,
  stepNumber: number,
): string {
  return `tool:${scope.attemptId}:${callId}:${String(stepNumber)}`;
}

export function inputIdempotencyKey(sessionId: string, turnId: string, requestId: string): string {
  return `input:${sessionId}:${turnId}:${requestId}`;
}

export function channelDeliveryIdempotencyKey(sessionId: string, deliveryId: string): string {
  return `channel-delivery:${sessionId}:${deliveryId}`;
}

export interface InstrumentationChannelDeliveryRef {
  readonly channelKind: string;
  readonly channelName: string;
  readonly deliveryId: string;
  readonly requestId?: string;
  readonly requestTraceContext?: InstrumentationTraceContext;
}

/** Known framework delivery input; adapter-specific fields are never projected. */
export interface InstrumentationChannelDeliveryInput {
  readonly context?: readonly string[];
  readonly inputResponses?: readonly InstrumentationInputResponse[];
  readonly message?: unknown;
  readonly outputSchema?: unknown;
}

interface InstrumentationChannelDeliveryScope {
  readonly agentName?: string;
  readonly delivery: InstrumentationChannelDeliveryRef;
  readonly idempotencyKey: string;
  readonly rootSessionId: string;
  readonly sequence?: number;
  readonly sessionId: string;
  readonly turnId?: string;
}

export interface InstrumentationChannelDeliveryStartedEvent extends InstrumentationChannelDeliveryScope {
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly type: "channel.delivery.started";
  /** Content. Absent unless this provider declared `capture: "content"`. */
  readonly input?: InstrumentationChannelDeliveryInput;
}

export type InstrumentationChannelDeliveryOutcome = "cancelled" | "completed" | "failed";

export interface InstrumentationChannelDeliveryTerminalEvent extends InstrumentationChannelDeliveryScope {
  readonly type:
    | "channel.delivery.cancelled"
    | "channel.delivery.completed"
    | "channel.delivery.failed";
  /** Content. Absent unless this provider declared `capture: "content"`. */
  readonly error?: unknown;
  readonly errorCode?: string;
  readonly outcome: InstrumentationChannelDeliveryOutcome;
}

/** Framework-owned reason an agent suspended for user input. */
export type InstrumentationInputKind = "question" | "session-limit" | "tool-approval";

export interface InstrumentationInputOption {
  readonly description?: string;
  readonly id: string;
  readonly label: string;
  readonly style?: "danger" | "default" | "primary";
}

/** User-facing input request content projected without runtime-owned types. */
export interface InstrumentationInputRequest {
  readonly allowFreeform?: boolean;
  readonly display?: "confirmation" | "select" | "text";
  readonly options?: readonly InstrumentationInputOption[];
  readonly prompt: string;
}

/** User response content projected without runtime-owned types. */
export interface InstrumentationInputResponse {
  readonly optionId?: string;
  readonly text?: string;
}

export type InstrumentationInputOutcome =
  | "answered"
  | "approved"
  | "cancelled"
  | "denied"
  | "failed"
  | "ignored"
  | "invalid";

export interface InstrumentationInputRequestedEvent {
  readonly type: "input.requested";
  readonly action: {
    readonly callId: string;
    readonly name: string;
  };
  readonly idempotencyKey: string;
  readonly kind: InstrumentationInputKind;
  /** Content. Absent unless this provider declared `capture: "content"`. */
  readonly request?: InstrumentationInputRequest;
  readonly requestId: string;
  readonly scope: InstrumentationAttemptScope;
}

export interface InstrumentationInputResolvedEvent {
  readonly type: "input.resolved";
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly kind: InstrumentationInputKind;
  readonly outcome: InstrumentationInputOutcome;
  readonly requestId: string;
  /** Content. Absent unless this provider declared `capture: "content"`. */
  readonly response?: InstrumentationInputResponse;
  readonly scope: InstrumentationAttemptScope;
}

/** Runtime action call IDs are durable and unique within one session. */
export function actionIdempotencyKey(sessionId: string, turnId: string, callId: string): string {
  return `action:${sessionId}:${turnId}:${callId}`;
}

export interface InstrumentationStepAttemptStartedEvent {
  readonly type: "step.attempt.started";
  readonly idempotencyKey: string;
  readonly operation: InstrumentationOperationRef;
  /**
   * Merged runtime context for this attempt: framework `eve.*` keys plus every
   * destination's `runtimeContext` contribution, allowlisted onto the AI SDK
   * call. eve's OTel provider writes these onto the step and operation spans.
   */
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
  readonly scope: InstrumentationAttemptScope;
}

export interface InstrumentationSessionStartedEvent {
  readonly type: "session.started";
  readonly agentName?: string;
  readonly channelKind?: string;
  readonly idempotencyKey: string;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly rootSessionId: string;
  readonly sessionId: string;
}

export type InstrumentationTraceContext = RuntimeTraceContext;

/**
 * Which tool call dispatched a subagent child. The trace structure alone
 * cannot say: one turn's children all parent to the same window.
 */
export interface InstrumentationParentLineage {
  readonly callId: string;
  readonly sessionId: string;
  readonly subagentName?: string;
  readonly turnId: string;
}

/**
 * A session transition that carries no failure.
 *
 * `session.waiting` sits here rather than with the failed shape because it is
 * not terminal: the session suspends awaiting input or approval and may resume
 * with a new turn.
 */
export interface InstrumentationSessionSettledEvent {
  readonly type: "session.completed" | "session.waiting";
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId?: string;
}

export interface InstrumentationSessionFailedEvent {
  readonly type: "session.failed";
  /** Content. Absent unless this provider declared `capture: "content"`. */
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId?: string;
}

export type InstrumentationSessionTransitionEvent =
  | InstrumentationSessionSettledEvent
  | InstrumentationSessionFailedEvent;

export interface InstrumentationTurnStartedEvent {
  readonly type: "turn.started";
  readonly idempotencyKey: string;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly rootSessionId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly turnId: string;
}

/**
 * A turn that ended without a failure.
 *
 * `turn.cancelled` sits here rather than with the failed shape because
 * cancellation is not an error: the harness settles a cancelled turn as
 * `turn.cancelled` → `session.waiting`, with no failure surfaced anywhere.
 */
export interface InstrumentationTurnSettledEvent {
  readonly type: "turn.cancelled" | "turn.completed";
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface InstrumentationTurnFailedEvent {
  readonly type: "turn.failed";
  /** Content. Absent unless this provider declared `capture: "content"`. */
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export type InstrumentationTurnTerminalEvent =
  | InstrumentationTurnSettledEvent
  | InstrumentationTurnFailedEvent;

export interface InstrumentationStepAttemptCompletedEvent {
  readonly type: "step.attempt.completed";
  readonly idempotencyKey: string;
  readonly scope: InstrumentationAttemptScope;
}

export interface InstrumentationStepAttemptFailedEvent {
  readonly type: "step.attempt.failed";
  /** Content. Absent unless this provider declared `capture: "content"`. */
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly scope: InstrumentationAttemptScope;
}

export type InstrumentationStepAttemptTerminalEvent =
  | InstrumentationStepAttemptCompletedEvent
  | InstrumentationStepAttemptFailedEvent;

/**
 * Provider metadata for one completed attempt, as reported by the AI SDK
 * (`StepResult.providerMetadata`). Carries Vercel AI Gateway cost data when
 * the request went through the gateway; absent for other providers.
 */
export interface InstrumentationStepAttemptMetadataEvent {
  readonly type: "step.attempt.metadata";
  readonly idempotencyKey: string;
  readonly scope: InstrumentationAttemptScope;
  readonly providerMetadata: Readonly<Record<string, unknown>>;
}

export interface InstrumentationModelCallStartedEvent {
  readonly type: "model.call.started";
  readonly idempotencyKey: string;
  /** Content. Absent unless this provider declared `capture: "content"`. */
  readonly input?: InstrumentationModelInput;
  readonly model: InstrumentationModelRef;
  /** The attempt's merged runtime context, written onto the chat span. */
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
  readonly scope: InstrumentationAttemptScope;
}

export interface InstrumentationModelCallCompletedEvent {
  readonly type: "model.call.completed";
  /** Content. Absent unless this provider declared `capture: "content"`. */
  readonly content?: readonly InstrumentationContentPart[];
  readonly finishReason: string;
  readonly idempotencyKey: string;
  readonly scope: InstrumentationAttemptScope;
  readonly usage: InstrumentationUsage;
}

export interface InstrumentationModelCallFailedEvent {
  readonly type: "model.call.failed";
  /** Content. Absent unless this provider declared `capture: "content"`. */
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly scope: InstrumentationAttemptScope;
}

export type InstrumentationModelCallTerminalEvent =
  | InstrumentationModelCallCompletedEvent
  | InstrumentationModelCallFailedEvent;

export type InstrumentationToolOutput = InstrumentationActionOutput;

export interface InstrumentationToolCallStartedEvent {
  readonly type: "tool.call.started";
  readonly callId: string;
  readonly idempotencyKey: string;
  readonly input: unknown;
  readonly scope: InstrumentationAttemptScope;
  readonly toolName: string;
}

export interface InstrumentationToolCallCompletedEvent {
  readonly type: "tool.call.completed";
  readonly idempotencyKey: string;
  readonly output: InstrumentationToolOutput;
  readonly scope: InstrumentationAttemptScope;
}

export interface InstrumentationToolCallFailedEvent {
  readonly type: "tool.call.failed";
  /** Content. Absent unless this provider declared `capture: "content"`. */
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly scope: InstrumentationAttemptScope;
}

export type InstrumentationToolCallTerminalEvent =
  | InstrumentationToolCallCompletedEvent
  | InstrumentationToolCallFailedEvent;

/**
 * One thing the agent did on the model's behalf. `kind` is what separates a
 * subagent or remote-agent call from an ordinary tool; `name` is the name the
 * model called, which is the tool name for every kind.
 */
export interface InstrumentationActionStartedEvent {
  readonly type: "action.started";
  readonly callId: string;
  readonly idempotencyKey: string;
  /** Content. Absent unless this provider declared `capture: "content"`. */
  readonly input?: unknown;
  readonly kind: InstrumentationActionKind;
  readonly name: string;
  readonly scope: InstrumentationAttemptScope;
}

export type InstrumentationActionOutcome =
  | "abandoned"
  | "cancelled"
  | "completed"
  | "failed"
  | "rejected";

export interface InstrumentationActionCompletedEvent {
  readonly type: "action.completed";
  readonly acceptedAtMs?: number;
  readonly idempotencyKey: string;
  readonly outcome: "completed";
  readonly output: InstrumentationActionOutput;
  readonly scope: InstrumentationAttemptScope;
  readonly usage?: InstrumentationUsage;
}

export interface InstrumentationActionFailedEvent {
  readonly type: "action.failed";
  readonly acceptedAtMs?: number;
  /** Content. Absent unless this provider declared `capture: "content"`. */
  readonly error?: unknown;
  readonly errorCode?: string;
  readonly idempotencyKey: string;
  readonly outcome: Exclude<InstrumentationActionOutcome, "completed">;
  readonly scope: InstrumentationAttemptScope;
}

export type InstrumentationActionTerminalEvent =
  | InstrumentationActionCompletedEvent
  | InstrumentationActionFailedEvent;

/** The second argument to every handler. */
export interface InstrumentationHandlerContext {
  /** Durable state scoped to this provider and this operation. */
  readonly state: InstrumentationStateSlot;
}

/**
 * The AI SDK can omit a model terminal when an incomplete stream closes. A
 * handler can use `ctx.state` for durable correlation when a terminal arrives,
 * but providers must scope live resources to the attempt and release anything
 * still open when the step attempt terminates.
 */
export type InstrumentationEventHandler<TEvent> = (
  event: TEvent,
  ctx: InstrumentationHandlerContext,
) => void | PromiseLike<void>;

/** Internal provider shape mirrored by the future public hook contract. */
export interface InstrumentationProviderDefinition {
  readonly name: string;
  /** Durable state identity, separate from the human-readable log name. */
  readonly stateNamespace?: string;
  /** Defaults to `"metadata"`. See {@link InstrumentationCapture}. */
  readonly capture?: InstrumentationCapture;
  readonly events?: {
    readonly "channel.delivery.started"?: InstrumentationEventHandler<InstrumentationChannelDeliveryStartedEvent>;
    readonly "channel.delivery.cancelled"?: InstrumentationEventHandler<InstrumentationChannelDeliveryTerminalEvent>;
    readonly "channel.delivery.completed"?: InstrumentationEventHandler<InstrumentationChannelDeliveryTerminalEvent>;
    readonly "channel.delivery.failed"?: InstrumentationEventHandler<InstrumentationChannelDeliveryTerminalEvent>;
    readonly "step.attempt.started"?: InstrumentationEventHandler<InstrumentationStepAttemptStartedEvent>;
    readonly "step.attempt.completed"?: InstrumentationEventHandler<InstrumentationStepAttemptCompletedEvent>;
    readonly "step.attempt.failed"?: InstrumentationEventHandler<InstrumentationStepAttemptFailedEvent>;
    readonly "step.attempt.metadata"?: InstrumentationEventHandler<InstrumentationStepAttemptMetadataEvent>;
    readonly "model.call.started"?: InstrumentationEventHandler<InstrumentationModelCallStartedEvent>;
    readonly "model.call.completed"?: InstrumentationEventHandler<InstrumentationModelCallCompletedEvent>;
    readonly "model.call.failed"?: InstrumentationEventHandler<InstrumentationModelCallFailedEvent>;
    readonly "input.requested"?: InstrumentationEventHandler<InstrumentationInputRequestedEvent>;
    readonly "input.resolved"?: InstrumentationEventHandler<InstrumentationInputResolvedEvent>;
    readonly "session.completed"?: InstrumentationEventHandler<InstrumentationSessionSettledEvent>;
    readonly "session.failed"?: InstrumentationEventHandler<InstrumentationSessionFailedEvent>;
    readonly "session.started"?: InstrumentationEventHandler<InstrumentationSessionStartedEvent>;
    readonly "session.waiting"?: InstrumentationEventHandler<InstrumentationSessionSettledEvent>;
    readonly "action.started"?: InstrumentationEventHandler<InstrumentationActionStartedEvent>;
    readonly "action.completed"?: InstrumentationEventHandler<InstrumentationActionCompletedEvent>;
    readonly "action.failed"?: InstrumentationEventHandler<InstrumentationActionFailedEvent>;
    readonly "tool.call.started"?: InstrumentationEventHandler<InstrumentationToolCallStartedEvent>;
    readonly "tool.call.completed"?: InstrumentationEventHandler<InstrumentationToolCallCompletedEvent>;
    readonly "tool.call.failed"?: InstrumentationEventHandler<InstrumentationToolCallFailedEvent>;
    readonly "turn.cancelled"?: InstrumentationEventHandler<InstrumentationTurnSettledEvent>;
    readonly "turn.completed"?: InstrumentationEventHandler<InstrumentationTurnSettledEvent>;
    readonly "turn.failed"?: InstrumentationEventHandler<InstrumentationTurnFailedEvent>;
    readonly "turn.started"?: InstrumentationEventHandler<InstrumentationTurnStartedEvent>;
  };
  /** Drains anything buffered. Driven by the runtime, not by the bus. */
  readonly flush?: () => void | PromiseLike<void>;
  /** Releases resources when the process is going away. */
  readonly shutdown?: () => void | PromiseLike<void>;
}

type InstrumentationProviderInput = Omit<InstrumentationProviderDefinition, "name"> & {
  readonly name?: string;
};

export interface InstrumentationDispatchGroups {
  readonly serialBefore?: readonly InstrumentationProviderDefinition[];
  readonly parallel?: readonly InstrumentationProviderDefinition[];
  readonly serialAfter?: readonly InstrumentationProviderDefinition[];
}

export type InstrumentationHooksInput =
  | readonly InstrumentationProviderInput[]
  | InstrumentationDispatchGroups;

/** Events that pair a start with its terminal under one `idempotencyKey`. */
export type InstrumentationCorrelatedEvent =
  | InstrumentationChannelDeliveryStartedEvent
  | InstrumentationChannelDeliveryTerminalEvent
  | InstrumentationInputRequestedEvent
  | InstrumentationInputResolvedEvent
  | InstrumentationActionStartedEvent
  | InstrumentationActionTerminalEvent
  | InstrumentationModelCallStartedEvent
  | InstrumentationModelCallTerminalEvent
  | InstrumentationToolCallStartedEvent
  | InstrumentationToolCallTerminalEvent;

export type InstrumentationPointEvent =
  | InstrumentationStepAttemptStartedEvent
  | InstrumentationStepAttemptMetadataEvent
  | InstrumentationStepAttemptTerminalEvent
  | InstrumentationSessionStartedEvent
  | InstrumentationSessionTransitionEvent
  | InstrumentationTurnStartedEvent
  | InstrumentationTurnTerminalEvent;

export type InstrumentationEvent = InstrumentationCorrelatedEvent | InstrumentationPointEvent;

/** Trusted framework operation for activating context around AI SDK execution. */
export type InstrumentationContextRunner = <T>(
  operation: InstrumentationExecutionOperation,
  execute: () => PromiseLike<T>,
) => PromiseLike<T>;

/** Stable identity supplied only to a trusted framework context runner. */
export type InstrumentationExecutionOperation =
  | {
      readonly idempotencyKey: string;
      readonly scope: InstrumentationAttemptScope;
      readonly type: "tool.call";
    }
  | {
      readonly idempotencyKey: string;
      readonly scope: InstrumentationAttemptScope;
      readonly type: "model.call";
    };

/** Provider-neutral hook operations consumed by the AI SDK bridge. */
export interface InstrumentationHooks {
  /**
   * Whether any registered provider declared `capture: "content"`.
   *
   * False means nothing downstream can read what was said, so the publisher
   * should not serialize it in the first place. This is the only way the
   * projection is skipped rather than merely withheld.
   */
  readonly capturesContent: boolean;
  publish(event: InstrumentationEvent): Promise<void>;
}

export interface CreateInstrumentationHooksOptions {
  readonly handlerTimeoutMs?: number;
}

/** Creates failure-isolated hooks backed by normalized dispatch groups. */
export function createInstrumentationHooks(
  input: InstrumentationHooksInput,
  options: CreateInstrumentationHooksOptions = {},
): InstrumentationHooks {
  return createInstrumentationDispatcher(input, options);
}
