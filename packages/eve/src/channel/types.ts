import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { MessageContent } from "#shared/message-content.js";
import type { ChannelDelivery } from "#shared/channel-delivery.js";

import type { RemoteChildBinding } from "#execution/child-binding.js";
import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import type { CancelTurnResult as ProtocolCancelTurnResult } from "#protocol/cancel-turn.js";
import type {
  RuntimeSubagentChildResult,
  RuntimeSubagentDispatchFailure,
  RuntimeToolResultActionResult,
} from "#shared/action-types.js";
import type {
  InteractionOpenedData,
  InteractionSettledData,
} from "#protocol/session-events/families/interaction.js";
import type { ResponseOutcome } from "#protocol/session-events/families/response.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import type { JsonObject } from "#shared/json.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";
import type { ForwardedTraceAssertion } from "#shared/forwarded-trace-policy.js";
import type { ConversationContext } from "#shared/conversation-context.js";
import type { StubScope } from "#tool-stubs/types.js";

export type { ContextAccessor } from "#context/key.js";
export type { ChannelInstrumentationProjection } from "#channel/instrumentation.js";

import type { ChannelInstrumentationProjection } from "#channel/instrumentation.js";

export interface CancelTurnInput {
  readonly sessionId: string;
  readonly turnId?: string | null;
}

export type CancelTurnResult = ProtocolCancelTurnResult;

export type CompactSessionResult =
  | { readonly status: "accepted"; readonly sessionId: string }
  | { readonly status: "no_active_session" };

export type ClearSessionResult =
  | { readonly status: "accepted"; readonly sessionId: string }
  | { readonly status: "no_active_session" };

/**
 * Identifies one turn within a session.
 *
 * `id` is the stable, unique turn identifier. `sequence` is the turn's
 * zero-based position in the session's turn order (the first turn is `0`).
 */
export interface SessionTurn {
  readonly id: string;
  readonly sequence: number;
}

/**
 * Lineage metadata for the eve parent execution that delegated this session.
 *
 * `sessionId` and `turn` describe the **immediate** parent that dispatched
 * this child. `rootSessionId` denormalizes the top of the dispatch chain so
 * descendants identify the user-facing session without walking up
 * parent-by-parent. Always populated at dispatch: a first-level child sets it
 * to the top session's id (its immediate parent), and deeper descendants
 * inherit the same root.
 */
export interface SessionParent {
  /**
   * Parent runtime-action tool call id that created this child session.
   */
  readonly callId: string;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly turn: SessionTurn;
}

export type SessionTraceRoot =
  | { readonly kind: "own" }
  | { readonly kind: "inherited"; readonly sessionId: string };

export interface SessionTraceSeed {
  readonly decision?: InstrumentationDecision;
  readonly forwardedTracePolicy?: ForwardedTraceAssertion;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceId: string;
}

export interface ChannelDeliveryMetadata {
  readonly acceptedDeploymentId?: string;
  readonly channelKind: string;
  readonly channelName: string;
  readonly deliveryId: string;
  readonly hook?: string;
  readonly requestId?: string;
  readonly requestTraceContext?: SessionTraceSeed;
}

export interface ChannelDeliveryMetadataEntry extends ChannelDeliveryMetadata {
  readonly payloadIndex: number;
}

/**
 * Authenticated caller principal attached to a request.
 *
 * Route-level auth strategies (JWT, OIDC, HTTP Basic, etc.) produce this
 * and pass it to the runtime on {@link RunInput.auth} and
 * {@link DeliverInput.auth}.
 */
export interface SessionAuthContext {
  readonly attributes: Readonly<Record<string, string | readonly string[]>>;
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly subject?: string;
}

export interface TurnCaller {
  readonly callId: string;
  readonly directTask?: import("#subagents/adapter-state.js").DirectSubagentTaskRef;
  readonly subagentName: string;
  readonly replyTo:
    | { readonly kind: "hook"; readonly token: string }
    | { readonly kind: "callback"; readonly token: string; readonly url: string };
}

export interface DeliverPayload extends Omit<ChannelDelivery, "state"> {
  readonly history?: readonly SessionHistoryMessage[];
  readonly state?: unknown;
  readonly [key: string]: unknown;
}

/** Whether a message joins a running turn (`"steer"`) or waits for it to end (`"queue"`). */
export type TurnMode = "steer" | "queue";

/**
 * What a steering message does when the running turn runs as another principal.
 * - `"match"` (the default): it joins only a turn whose caller is its sender.
 * - `"retain"`: it also joins another principal's turn as input, and the turn retains its caller.
 */
export type PrincipalPolicy = "match" | "retain";

/**
 * Controls how a channel message interacts with an active turn: `"steer"` joins it, and
 * `"queue"` waits for it to end. `"steer"` is `{ mode: "steer" }`, and `"queue"` is
 * `{ mode: "queue" }`.
 *
 * A steering policy's `principal` decides what the message does when the turn runs as someone
 * else:
 * - `"match"` (the default): the message waits for the turn to end, then starts a turn as its sender.
 * - `"retain"`: the message joins as input, and the turn retains its caller.
 */
export type TurnPolicy =
  | TurnMode
  | { readonly mode: "queue" }
  | { readonly mode: "steer"; readonly principal?: PrincipalPolicy };

export const DEFAULT_TURN_POLICY: TurnMode = "steer";

export function storedTurnPolicy(policy: TurnPolicy): {
  readonly turnPolicy: TurnMode;
  readonly principalPolicy?: PrincipalPolicy;
} {
  if (typeof policy === "string") return { turnPolicy: policy };
  if (policy.mode !== "steer" || policy.principal === undefined || policy.principal === "match") {
    return { turnPolicy: policy.mode };
  }
  return { turnPolicy: "steer", principalPolicy: policy.principal };
}

export type SessionCommand =
  | {
      readonly idempotencyKey?: string;
      readonly auth?: SessionAuthContext | null;
      /** @internal */
      readonly steeredBy?: readonly SessionAuthContext[];
      readonly caller?: TurnCaller;
      readonly title?: string;
      readonly kind: "send";
      readonly schedule?: import("#context/session-schedule.js").SessionSchedule;
      readonly payload: DeliverPayload;
      readonly delivery?: ChannelDeliveryMetadata;
      readonly requestId?: string;
      readonly turnPolicy?: TurnMode;
      readonly principalPolicy?: PrincipalPolicy;
    }
  | ({
      readonly kind: "cancel";
      readonly turnId?: string | null;
    } & SessionControlIdentity)
  | { readonly kind: "prewarm"; readonly targetDeploymentId?: string }
  | ({ readonly kind: "compact" } & SessionControlIdentity)
  | ({ readonly kind: "clear" } & SessionControlIdentity)
  | ({ readonly kind: "reset"; readonly reason?: string } & SessionControlIdentity);

export interface SessionControlIdentity {
  readonly deliveryId: string;
  readonly auth?: SessionAuthContext | null;
}

/** Who sends a control, so the delivery it arrives as names them. */
export interface SessionControlOptions {
  readonly auth?: SessionAuthContext | null;
}

export function controlCommand<
  TCommand extends { readonly kind: "cancel" | "clear" | "compact" | "reset" },
>(
  command: TCommand,
  options?: SessionControlOptions,
): TCommand & SessionControlIdentity & { readonly deliveryId: string } {
  const deliveryId = crypto.randomUUID();
  return options?.auth === undefined
    ? { ...command, deliveryId }
    : { ...command, auth: options.auth, deliveryId };
}

export type SessionSendCommandResult =
  | {
      readonly status: "accepted";
      readonly sessionId: string;
      readonly deliveryId?: string;
      readonly inbox?: string;
    }
  | { readonly status: "session_not_active" };

export type EndSessionResult =
  | { readonly status: "reset"; readonly previousSessionId: string }
  | { readonly status: "no_active_session" };

export type SessionCommandResult<TCommand extends SessionCommand = SessionCommand> =
  TCommand extends { readonly kind: "prewarm" }
    ? import("#protocol/prewarm-session.js").PrewarmSessionResult
    : TCommand extends { readonly kind: "send" }
      ? SessionSendCommandResult
      : TCommand extends { readonly kind: "cancel" }
        ? CancelTurnResult
        : TCommand extends { readonly kind: "compact" }
          ? CompactSessionResult
          : TCommand extends { readonly kind: "clear" }
            ? ClearSessionResult
            : EndSessionResult;

export interface DispatchContinuationInput<TCommand extends SessionCommand = SessionCommand> {
  readonly command: TCommand;
  readonly continuationToken: string;
  readonly successor?: RunInput;
}

export interface DispatchSessionInput<TCommand extends SessionCommand = SessionCommand> {
  readonly inbox?: string;
  readonly command: TCommand;
  readonly sessionId: string;
}

export interface DeliverHookPayload {
  readonly idempotencyKey?: string;
  readonly schedule?: import("#context/session-schedule.js").SessionSchedule;
  readonly title?: string;
  readonly auth?: SessionAuthContext | null;
  /** @internal */
  readonly steeredBy?: readonly SessionAuthContext[];
  readonly caller?: TurnCaller;
  readonly deliveryMetadata?: readonly ChannelDeliveryMetadataEntry[];
  readonly requestId?: string;
  readonly kind: "deliver";
  readonly payloads: readonly DeliverPayload[];
  readonly turnPolicy?: TurnMode;
  readonly principalPolicy?: PrincipalPolicy;
}

export interface SessionTimeoutHookPayload {
  readonly kind: "session-timeout";
  readonly ownerRunId: string;
}

export interface CompactSessionHookPayload {
  readonly kind: "compact";
}

export interface ClearSessionHookPayload {
  readonly kind: "clear";
}

export interface RuntimeActionResultHookPayload {
  readonly kind: "runtime-action-result";
  readonly results: readonly (
    | RuntimeSubagentChildResult
    | RuntimeSubagentDispatchFailure
    | RuntimeToolResultActionResult
  )[];
}

export type RelayedInteractionEvent =
  | {
      readonly type: "interaction.opened";
      readonly data: InteractionOpenedData;
    }
  | {
      readonly type: "interaction.settled";
      readonly data: InteractionSettledData;
    }
  | {
      readonly type: "response.admitted";
      readonly data: RelayedResponseAdmission;
    }
  | {
      readonly type: "response.settled";
      readonly data: RelayedResponseSettlement;
    };

export interface RelayedResponseAdmission {
  readonly interactionId: string;
  readonly deliveryId?: string;
}

export interface RelayedResponseSettlement {
  readonly interactionId: string;
  readonly deliveryId?: string;
  readonly outcome: ResponseOutcome;
  readonly reason?: string;
}

export interface RelayRoute {
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  readonly inputSource?: string;
  readonly remote?: import("#eve-channel/support.js").RemoteAgentBinding & {
    readonly sessionId: string;
  };
}

export interface SubagentInteractionHookPayload {
  readonly kind: "subagent-interaction";
  readonly callId: string;
  readonly childSessionId: string;
  readonly subagentName: string;
  readonly events: readonly RelayedInteractionEvent[];
  readonly route?: RelayRoute;
}

export type HookPayload =
  | ClearSessionHookPayload
  | CompactSessionHookPayload
  | DeliverHookPayload
  | RuntimeActionResultHookPayload
  | SessionTimeoutHookPayload
  | SubagentInteractionHookPayload;

export interface SessionCallback {
  readonly callId: string;
  readonly subagentName: string;
  readonly token: string;
  readonly url: string;
}

export interface SessionCapabilities {
  readonly requestInput?: boolean;
}

export interface RunInput {
  readonly idempotencyKey?: string;
  /** @internal */
  readonly toolStubs?: StubScope;
  readonly schedule?: import("#context/session-schedule.js").SessionSchedule;
  readonly adapter: ChannelAdapter<any>;
  readonly channelName?: string;
  readonly channelMetadata?: ChannelInstrumentationProjection;
  readonly inheritedConversation?: ConversationContext;
  readonly delivery?: ChannelDeliveryMetadata;
  readonly auth: SessionAuthContext | null;
  /** @internal */
  readonly steeredBy?: readonly SessionAuthContext[];
  readonly audienceAuth?: SessionAuthContext | null;
  readonly capabilities?: SessionCapabilities;
  readonly requestId?: string;
  readonly title?: string;
  readonly callback?: SessionCallback;
  readonly earlierCallerProtocol?: number;
  readonly continuationToken?: string;
  readonly continuationConflictCommand?: Extract<SessionCommand, { readonly kind: "send" }>;
  readonly initiatorAuth?: SessionAuthContext | null;
  readonly input: {
    readonly message?: MessageContent;
    readonly context?: readonly string[];
    readonly history?: readonly SessionHistoryMessage[];
    readonly outputSchema?: JsonObject;
    readonly state?: unknown;
  };
  readonly conversationId?: string;
  readonly parent?: SessionParent;
  readonly traceRoot?: SessionTraceRoot;
  readonly parentTraceContext?: SessionTraceSeed;
  readonly externalInvocation?: {
    readonly continuationToken: string;
    readonly ownerKey: string;
  };
}

export interface DeliverInput {
  readonly auth?: SessionAuthContext | null;
  readonly caller?: TurnCaller;
  readonly requestId?: string;
  readonly continuationToken: string;
  readonly payload: DeliverPayload;
}

export interface RunHandle {
  readonly deliveryId?: string;
  readonly events: ReadableStream<SessionStreamEvent>;
  readonly sessionId: string;
  readonly claimedContinuation?: boolean;
}

export interface Runtime {
  createSession(input: RunInput): Promise<RunHandle>;

  dispatchContinuation<TCommand extends SessionCommand>(
    input: DispatchContinuationInput<TCommand>,
  ): Promise<SessionCommandResult<TCommand>>;

  dispatchSession<TCommand extends SessionCommand>(
    input: DispatchSessionInput<TCommand>,
  ): Promise<SessionCommandResult<TCommand>>;

  resolveContinuation(
    continuationToken: string,
    options?: { readonly runnable?: boolean },
  ): Promise<{ sessionId: string } | undefined>;

  getEventStream(
    sessionId: string,
    options?: SessionStreamOptions,
  ): Promise<ReadableStream<SessionStreamEvent>>;

  getLineStream(
    sessionId: string,
    options?: SessionStreamOptions,
  ): Promise<ReadableStream<unknown>>;

  getStreamTailIndex(sessionId: string): Promise<number>;

  readChildBinding?(
    sessionId: string,
    childSessionId: string,
  ): Promise<RemoteChildBinding | undefined>;

  hasRunnableOwner?(sessionId: string): Promise<boolean>;
}

export type { SessionStreamOptions } from "#shared/session.js";
import type { SessionStreamOptions } from "#shared/session.js";
