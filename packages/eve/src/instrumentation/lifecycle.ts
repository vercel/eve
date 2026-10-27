import type { Cause } from "#protocol/session-events/envelope.js";
import type { ModelOutcome } from "#protocol/session-events/families/model.js";
import type { Capability } from "#protocol/session-events/families/call.js";
import type { DeliverySettledData } from "#protocol/session-events/families/delivery.js";
import type {
  InteractionOption,
  InteractionOutcome,
  InteractionRequest,
} from "#protocol/session-events/families/interaction.js";
import type { ResponseValue } from "#protocol/session-events/families/response.js";
import type { CallOutcome } from "#protocol/session-events/families/call.js";
import type { SessionOutcome } from "#protocol/session-events/families/session.js";
import type { TurnOutcome } from "#protocol/session-events/families/turn.js";
import { createInstrumentationDispatcher } from "#instrumentation/dispatch.js";
import type * as memory from "#instrumentation/memory.js";
import type { InstrumentationStateSlot } from "#instrumentation/state.js";
import type { TraceContext } from "#protocol/session-events/families/session.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";
import type { TraceCaptureContext, TraceCapturePolicy } from "#shared/trace-policy.js";

/**
 * Identifies one attempt of a model run. Compaction can run outside a turn.
 */
export interface InstrumentationScope {
  readonly traceSessionId?: string;
  readonly channelAudience?: ChannelAudience;
  readonly runId: string;
  readonly attempt: number;
  readonly functionId?: string;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly turnId?: string;
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
  /** Provider-reported cost in US dollars. Absent when the provider omits pricing. */
  readonly costUsd?: number;
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
  readonly tools?: readonly unknown[];
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
 * Every event carries an `idempotencyKey` naming the operation it is about: a
 * start and its terminal share one, and two operations never collide.
 *
 * Every part is identity eve reconstructs on replay — session and turn ids,
 * run id and retry attempt, AI SDK step number,
 * and durable runtime-action call ids. A provider writing rows can use the key
 * as its row id and be idempotent by construction.
 */
export function sessionIdempotencyKey(sessionId: string): string {
  return `session:${sessionId}`;
}

export function turnIdempotencyKey(sessionId: string, turnId: string): string {
  return `turn:${sessionId}:${turnId}`;
}

export function attemptIdempotencyKey(scope: InstrumentationScope): string {
  return `model-run:${scope.sessionId}:${scope.runId}:${scope.attempt}`;
}

/** Identifies one provider call, including retries, within an AI SDK step. */
export function modelCallIdempotencyKey(
  scope: InstrumentationScope,
  stepNumber: number,
  callIndex: number,
): string {
  return `model:${scope.sessionId}:${scope.runId}:${scope.attempt}:${String(stepNumber)}:${String(callIndex)}`;
}

export function toolCallIdempotencyKey(
  scope: InstrumentationScope,
  callId: string,
  stepNumber: number,
): string {
  return `tool:${scope.sessionId}:${scope.runId}:${scope.attempt}:${callId}:${String(stepNumber)}`;
}

export function inputIdempotencyKey(
  sessionId: string,
  turnId: string | undefined,
  interactionId: string,
): string {
  return `input:${sessionId}:${turnId}:${interactionId}`;
}

export function channelDeliveryIdempotencyKey(sessionId: string, deliveryId: string): string {
  return `channel-delivery:${sessionId}:${deliveryId}`;
}

export interface InstrumentationChannelDeliveryRef {
  readonly channelAudience?: ChannelAudience;
  readonly channelKind: string;
  readonly channelName: string;
  readonly deliveryId: string;
  readonly requestId?: string;
  readonly requestTraceContext?: InstrumentationTraceContext;
}

/** Known framework delivery input; adapter-specific fields are never projected. */
export interface InstrumentationChannelDeliveryInput {
  readonly context?: readonly string[];
  readonly answers?: readonly InstrumentationAnswer[];
  readonly message?: unknown;
  readonly outputSchema?: unknown;
}

interface InstrumentationChannelDeliveryScope {
  readonly traceSessionId?: string;
  readonly agentName?: string;
  readonly delivery?: InstrumentationChannelDeliveryRef;
  readonly deliveryId: string;
  readonly idempotencyKey: string;
  readonly rootSessionId: string;
  readonly sequence?: number;
  readonly sessionId: string;
  readonly traceSeed?: InstrumentationTraceSeed;
  readonly turnId?: string;
}

export interface InstrumentationDeliveryConsumedEvent extends InstrumentationChannelDeliveryScope {
  readonly type: "delivery.consumed";
  readonly input?: InstrumentationChannelDeliveryInput;
}

export interface InstrumentationDeliverySettledEvent extends DeliverySettledData {
  readonly type: "delivery.settled";
  readonly idempotencyKey: string;
  readonly sessionId: string;
}

/** What a person is asked for: an approval, a question, or the budget prompt (never a sign-in). */
export type InstrumentationInteractionKind = InteractionRequest["kind"];

export type InstrumentationInteractionOption = InteractionOption;

/** User-facing input request content. */
export type InstrumentationInteractionRequest = Pick<
  InteractionRequest,
  "allowFreeform" | "display" | "options" | "prompt" | "title"
>;

/** What a person answered. */
export type InstrumentationAnswer = ResponseValue;

/** How the request settled, as its `interaction.settled` says. */
export type InstrumentationInteractionOutcome = InteractionOutcome;

/** A person was asked: the session's `interaction.opened`, never a sign-in. */
export interface InstrumentationInteractionOpenedEvent {
  readonly type: "interaction.opened";
  /** The call the request is about: the call an approval gates, or the call that asked. */
  readonly call?: {
    readonly callId: string;
    readonly name: string;
  };
  readonly idempotencyKey: string;
  readonly interactionId: string;
  readonly kind: InstrumentationInteractionKind;
  /** Content. Absent unless this provider's trace policy records this direction. */
  readonly request?: InstrumentationInteractionRequest;
  readonly scope: InstrumentationScope;
}

/** The request settled: the session's `interaction.settled`. */
export interface InstrumentationInteractionSettledEvent {
  readonly type: "interaction.settled";
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly kind: InstrumentationInteractionKind;
  readonly interactionId: string;
  readonly outcome: InstrumentationInteractionOutcome;
  /** Content. Absent unless this provider's trace policy records this direction. */
  readonly answer?: InstrumentationAnswer;
  readonly scope: InstrumentationScope;
}

/** Runtime action call IDs are durable and unique within one session. */
export function actionIdempotencyKey(
  sessionId: string,
  turnId: string | undefined,
  callId: string,
): string {
  return `action:${sessionId}:${turnId}:${callId}`;
}

export interface InstrumentationModelStartedEvent {
  readonly type: "model.started";
  readonly idempotencyKey: string;
  readonly operation: InstrumentationOperationRef;
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
  readonly scope: InstrumentationScope;
}

export interface InstrumentationSessionStartedEvent {
  readonly traceSessionId?: string;
  readonly type: "session.started";
  readonly agentName?: string;
  readonly channelKind?: string;
  readonly channelType?: string;
  readonly channelAudience?: ChannelAudience;
  readonly idempotencyKey: string;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly rootSessionId: string;
  readonly scheduleId?: string;
  readonly sessionId: string;
  readonly title?: string;
  readonly traceSeed?: InstrumentationTraceSeed;
}

export type InstrumentationTraceContext = TraceContext;
export interface InstrumentationTraceSeed extends InstrumentationTraceContext {
  readonly decision?: InstrumentationDecision;
}

export const INSTRUMENTATION_PRINCIPAL_TYPES = [
  "anonymous",
  "app",
  "local-dev",
  "none",
  "other",
  "runtime",
  "service",
  "unknown",
  "user",
] as const;

export type InstrumentationPrincipalType = (typeof INSTRUMENTATION_PRINCIPAL_TYPES)[number];

export function isInstrumentationPrincipalType(
  value: unknown,
): value is InstrumentationPrincipalType {
  return INSTRUMENTATION_PRINCIPAL_TYPES.some((type) => type === value);
}

export interface InstrumentationPrincipalSummary {
  readonly id?: string;
  readonly type: InstrumentationPrincipalType;
}

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

/** How a session ended, as its `session.ended` says. */
export type InstrumentationSessionOutcome = SessionOutcome;

/** The session ended: its `session.ended`. */
export interface InstrumentationSessionEndedEvent {
  readonly type: "session.ended";
  readonly outcome: InstrumentationSessionOutcome;
  /** A failed session's error. Content: absent unless this provider records outputs. */
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  /** The turn that failed it, when one did; otherwise the session's latest turn. */
  readonly turnId?: string;
}

export interface InstrumentationTurnStartedEvent {
  readonly traceSessionId?: string;
  readonly type: "turn.started";
  readonly agentName?: string;
  readonly currentPrincipal?: InstrumentationPrincipalSummary;
  readonly idempotencyKey: string;
  readonly initiatorPrincipal?: InstrumentationPrincipalSummary;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly rootSessionId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly turnId: string;
}

/** How a turn ended, as its `turn.settled` says. */
export type InstrumentationTurnOutcome = TurnOutcome;

/** The turn ended: its `turn.settled`. A cancelled turn is no failure. */
export interface InstrumentationTurnSettledEvent {
  readonly type: "turn.settled";
  readonly outcome: InstrumentationTurnOutcome;
  /** A failed turn's error. Content: absent unless this provider records outputs. */
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface InstrumentationModelRetriedEvent {
  readonly type: "model.retried";
  readonly idempotencyKey: string;
  readonly scope: InstrumentationScope;
  readonly error?: unknown;
}

/**
 * How a model run ended, as its `model.settled` says, except that a run its turn's cancellation
 * cut is `cancelled` rather than `interrupted`: it stopped on purpose, not as a failure.
 */
export type InstrumentationModelOutcome = ModelOutcome | "cancelled";

export interface InstrumentationModelSettledEvent {
  readonly type: "model.settled";
  readonly outcome: InstrumentationModelOutcome;
  readonly idempotencyKey: string;
  readonly scope: InstrumentationScope;
  readonly error?: unknown;
}

export type InstrumentationModelTerminalEvent =
  | InstrumentationModelRetriedEvent
  | InstrumentationModelSettledEvent;

export interface InstrumentationModelCallStartedEvent {
  readonly type: "model.call.started";
  readonly idempotencyKey: string;
  /** Content. Absent unless this provider's trace policy records this direction. */
  readonly input?: InstrumentationModelInput;
  readonly model: InstrumentationModelRef;
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
  readonly scope: InstrumentationScope;
}

export interface InstrumentationModelCallCompletedEvent {
  readonly type: "model.call.settled";
  readonly outcome: "completed";
  /**
   * Provider metadata, as reported by the AI SDK. Carries Vercel AI Gateway cost and session
   * affinity routing data when the request went through the gateway; absent for other providers.
   * When the trace policy omits outputs, only the gateway's `cost`, `generationId`, and `routing`
   * fields remain.
   */
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
  /** Content. Absent unless this provider's trace policy records this direction. */
  readonly content?: readonly InstrumentationContentPart[];
  readonly finishReason: string;
  readonly idempotencyKey: string;
  readonly responseModelId?: string;
  readonly responseId?: string;
  readonly scope: InstrumentationScope;
  readonly usage: InstrumentationUsage;
}

export interface InstrumentationModelCallFailedEvent {
  readonly type: "model.call.settled";
  readonly outcome: "failed";
  /** Content. Absent unless this provider's trace policy records this direction. */
  readonly error?: unknown;
  readonly idempotencyKey: string;
  readonly scope: InstrumentationScope;
}

export type InstrumentationModelCallTerminalEvent =
  | InstrumentationModelCallCompletedEvent
  | InstrumentationModelCallFailedEvent;

/**
 * A call was requested: the session's `call.requested`, or a tool a channel runs directly (with
 * `invokeTool`), which no session stream records.
 */
export interface InstrumentationCallRequestedEvent {
  /** Durable dispatch metadata, when this call is owned by eve's tool loop. */
  readonly capability: Capability;
  readonly frameworkTool: boolean;
  readonly startedAtMs?: number;
  readonly type: "call.requested";
  readonly callId: string;
  readonly idempotencyKey: string;
  /** Content. Absent unless this provider's trace policy records inputs. */
  readonly input: unknown;
  readonly scope: InstrumentationScope;
  readonly toolName: string;
}

/** How a call ended, as its `call.settled` says. */
export type InstrumentationCallOutcome = CallOutcome;

/** The call settled: the session's `call.settled`, or a direct call's end. */
export interface InstrumentationCallSettledEvent {
  readonly type: "call.settled";
  readonly outcome: InstrumentationCallOutcome;
  /** A completed call's output. Content: absent unless this provider records outputs. */
  readonly output?: unknown;
  /** Why it didn't complete. Content: absent unless this provider records outputs. */
  readonly error?: unknown;
  readonly errorCode?: string;
  readonly usage?: InstrumentationUsage;
  readonly reason?: string;
  readonly cause?: Cause;
  readonly acceptedAtMs?: number;
  readonly completedAtMs?: number;
  /** How long the tool's `execute` ran, in milliseconds, when the publisher measured it. */
  readonly durationMs?: number;
  readonly idempotencyKey: string;
  readonly scope: InstrumentationScope;
}

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

/** Internal normalized provider shape consumed by the instrumentation bus. */
export interface InstrumentationProviderDefinition {
  readonly name: string;
  /** Durable state identity, separate from the human-readable log name. */
  readonly stateNamespace?: string;
  /** Internal provider-specific projection applied after capture filtering. */
  readonly projectEvent?: (
    event: InstrumentationEvent,
  ) => InstrumentationEvent | PromiseLike<InstrumentationEvent>;
  /** Provider-specific event admission and directional content policy. */
  readonly tracePolicy?: TraceCapturePolicy;
  readonly events?: {
    readonly [K in InstrumentationEvent["type"]]?: InstrumentationEventHandler<
      InstrumentationEvent<K>
    >;
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
  | InstrumentationDeliveryConsumedEvent
  | InstrumentationDeliverySettledEvent
  | InstrumentationInteractionOpenedEvent
  | InstrumentationInteractionSettledEvent
  | memory.InstrumentationMemoryOperationStartedEvent
  | memory.InstrumentationMemoryOperationTerminalEvent
  | InstrumentationModelCallStartedEvent
  | InstrumentationModelCallTerminalEvent
  | InstrumentationCallRequestedEvent
  | InstrumentationCallSettledEvent;

export type InstrumentationPointEvent =
  | InstrumentationModelStartedEvent
  | InstrumentationModelTerminalEvent
  | InstrumentationSessionStartedEvent
  | InstrumentationSessionEndedEvent
  | InstrumentationTurnStartedEvent
  | InstrumentationTurnSettledEvent;

type LifecycleEvent = InstrumentationCorrelatedEvent | InstrumentationPointEvent;
export type InstrumentationEvent<K extends LifecycleEvent["type"] = LifecycleEvent["type"]> =
  Extract<LifecycleEvent, { readonly type: K }>;

/** Trusted framework operation for activating context around AI SDK execution. */
export type InstrumentationContextRunner = <T>(
  operation: InstrumentationExecutionOperation,
  execute: () => PromiseLike<T>,
) => PromiseLike<T>;

/** Stable identity supplied only to a trusted framework context runner. */
export type InstrumentationExecutionOperation =
  | {
      readonly idempotencyKey: string;
      readonly scope: InstrumentationScope;
      readonly type: "tool.call";
      readonly callId?: string;
      readonly toolName?: string;
      readonly input?: unknown;
      readonly frameworkTool?: boolean;
      readonly startedAtMs?: number;
      readonly completedAtMs?: number;
      readonly failed?: boolean;
    }
  | {
      readonly idempotencyKey: string;
      readonly scope: InstrumentationScope;
      readonly type: "model.call";
    }
  | memory.InstrumentationMemoryExecutionOperation;

/** Provider-neutral hook operations consumed by the AI SDK bridge. */
export interface InstrumentationHooks {
  /**
   * Whether any provider admitted by this bound trace requests content.
   *
   * False means nothing downstream can read what was said, so the publisher
   * should not serialize it in the first place. This is the only way the
   * projection is skipped rather than merely withheld.
   */
  readonly capturesContent: boolean;
  /** Input-content demand for publishers that can project directions separately. */
  readonly capturesInputs?: boolean;
  /** Output-content demand for publishers that can project directions separately. */
  readonly capturesOutputs?: boolean;
  readonly forTrace?: (trace: TraceCaptureContext) => InstrumentationHooks;
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
