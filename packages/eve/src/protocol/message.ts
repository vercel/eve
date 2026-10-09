import type { FileUIPart, ProviderMetadata, TextUIPart, UserContent } from "ai";

import type { ConnectionAuthorizationChallenge } from "#connections/errors.js";
import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeToolResultActionResult,
} from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";

// The v26 stream events authored hooks, channels, and dynamic resolvers observe. Sessions write
// v27 facts; `execution/legacy-events.ts` translates each commit into these for authored code, so
// the authoring API stays as it was until its v27 form is designed.

export const EVE_SESSION_ID_HEADER = "x-eve-session-id";
export const EVE_STREAM_FORMAT_HEADER = "x-eve-stream-format";
export const EVE_STREAM_TAIL_INDEX_HEADER = "x-eve-stream-tail-index";
export const EVE_STREAM_VERSION_HEADER = "x-eve-stream-version";
export const EVE_MESSAGE_STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
export const EVE_MESSAGE_STREAM_FORMAT = "ndjson";
export const EVE_MESSAGE_STREAM_VERSION = "27";

/**
 * eve-owned finish reason for one completed assistant step.
 *
 * `tool-calls` is the only non-terminal assistant step in the current
 * tool-loop harness. All other values indicate the assistant step ended the
 * current turn, except a step superseded by a steering message: it completes
 * with `other` and the turn continues with the next step.
 */
export type AssistantStepFinishReason =
  | "content-filter"
  | "error"
  | "length"
  | "other"
  | "stop"
  | "tool-calls";

type ProviderMetadataEntry = NonNullable<ProviderMetadata[string]>;
type GatewayGenerationId = Extract<ProviderMetadataEntry["generationId"], string>;

export interface StepCompletedProviderMetadata {
  readonly gateway: {
    readonly generationId: GatewayGenerationId;
  };
}

/**
 * Durable metadata attached to one persisted session stream event.
 *
 * Stamped once, immediately before the event is written to the workflow-owned
 * stream, and stored with it. Re-reading the stream — reconnecting, rewinding,
 * or replaying a finished session — yields the same values every time.
 */
export interface MessageStreamEventMeta {
  /** Server-issued message delivery identities, retained across the turn's workflow steps. */
  readonly deliveryIds?: readonly string[];
  /** ISO-8601 emission time. */
  readonly at: string;
  /**
   * Unique, lexicographically sortable identifier for this event.
   *
   * Stamped from stream version 20 on: rewinding into a session that started
   * before the upgrade yields events whose `id` is absent despite this type,
   * and those cannot be deduplicated.
   */
  readonly id: string;
}

/**
 * Normalized completion status for one emitted runtime action result.
 *
 * `rejected` marks a tool call the user (or a policy) denied at a HITL
 * approval gate: it never executed, so it is neither a success nor a
 * runtime failure.
 */
export type ActionResultStatus = "completed" | "failed" | "rejected";

/**
 * Stable failure payload projected onto `action.result`.
 *
 * This keeps UI consumers from having to parse provider- or tool-specific
 * output strings just to determine whether a tool call failed.
 */
export interface ActionResultError {
  readonly code: string;
  readonly message: string;
}

/**
 * Invocation metadata attached to the `session.started` event for one child
 * subagent workflow session.
 */
export interface SubagentSessionInvocationMetadata {
  readonly kind: "subagent";
  readonly parentCallId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly name: string;
}

/**
 * Runtime identity metadata attached to the `session.started` event.
 *
 * The server populates this at run time so remote eval processes and
 * reporters receive authoritative metadata about the eve instance
 * serving the run.
 */
export interface RuntimeIdentity {
  readonly agentId: string;
  readonly agentName?: string;
  readonly eveVersion: string;
  readonly build?: {
    readonly deployedAt?: string;
    readonly gitBranch?: string;
    readonly gitSha?: string;
  };
}

/**
 * Portable trace coordinates for correlating an eve run with an external
 * observability backend. The fields follow the W3C trace-context model while
 * remaining owned by eve rather than exposing an OpenTelemetry type.
 */
export interface RuntimeTraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

/**
 * JSON request accepted by the canonical message route.
 *
 * `message` is either a plain text string or an AI SDK `UserContent`
 * array (mixing `text`, `image`, and `file` parts). Clients pass
 * multimodal attachments with the same shape AI SDK's `useChat`
 * `sendMessage({ files })` produces. `clientContext` is turn-scoped
 * client/page context; the channel converts it into internal model context
 * for every model call in that turn.
 */
export type HandleMessageRequestBody =
  | {
      readonly inputResponses?: never;
      readonly message: string | UserContent;
      readonly clientContext?: string | readonly string[] | JsonObject;
      readonly outputSchema?: JsonObject;
    }
  | {
      readonly inputResponses: readonly InputResponse[];
      readonly message?: never;
      readonly clientContext?: string | readonly string[] | JsonObject;
      readonly outputSchema?: JsonObject;
    };

/**
 * Stream event emitted when the durable message workflow session starts.
 */
export interface SessionStartedStreamEvent {
  data: {
    invocation?: SubagentSessionInvocationMetadata;
    runtime?: RuntimeIdentity;
    trace?: RuntimeTraceContext;
  };
  type: "session.started";
}

/**
 * Stream event emitted when one runtime turn starts.
 */
export interface TurnStartedStreamEvent {
  data: {
    sequence: number;
    trace?: RuntimeTraceContext;
    turnId: string;
  };
  type: "turn.started";
}

/**
 * Stream event emitted when the runtime receives one normalized user message.
 *
 * `message` is the existing flattened text summary. `parts` carries the
 * structured projection current emitters provide for clients that render
 * attachments.
 */
export interface MessageReceivedStreamEvent {
  data: {
    message: string;
    parts?: readonly MessageReceivedPart[];
    sequence: number;
    turnId: string;
  };
  type: "message.received";
}

/**
 * One structured part of a received user message.
 *
 * This mirrors the AI SDK UI text/file part surface, narrowed to renderable
 * metadata only. Raw bytes and framework-internal sandbox paths are never
 * projected; `url` is optional because it is present only for client-resolvable
 * `http(s)` and `data:` URLs.
 */
export type MessageReceivedPart =
  | Readonly<Pick<TextUIPart, "text" | "type">>
  | (Readonly<Pick<FileUIPart, "filename" | "mediaType" | "type">> & {
      readonly size?: number;
      readonly url?: FileUIPart["url"];
    });

/**
 * Stream event emitted when the model requests one or more actions.
 *
 * A `tool-call` is one action kind, alongside `load-skill` and subagent calls.
 * Calls may arrive incrementally before execution, so consumers must correlate
 * action lifecycles by call ID rather than assume one event contains every call
 * from an assistant step.
 */
export interface ActionPresentation {
  readonly label?: string;
}

export type ActionPresentationByCallId = Readonly<Record<string, ActionPresentation>>;

export interface ActionsRequestedStreamEvent {
  data: {
    actions: readonly RuntimeActionRequest[];
    presentation?: ActionPresentationByCallId;
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "actions.requested";
}

export type ApprovalCandidateOutcome = "pending" | "rejected" | "failed" | "timed-out" | "stale";

/** Safe lifecycle event for one responder-bound approval candidate. */
export interface ApprovalCandidateStreamEvent {
  data: {
    candidateId: string;
    outcome: ApprovalCandidateOutcome;
    requestId: string;
    responderPrincipalId: string;
    reason?: string;
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "approval.candidate";
}

/** Terminal durable settlement for one approval request. */
export interface ApprovalSettledStreamEvent {
  data: {
    outcome: "approved" | "cancelled";
    requestId: string;
    responderPrincipalId: string;
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "approval.settled";
}

/**
 * Stream event emitted when the harness needs human input before it can
 * continue the run.
 */
export interface InputRequestedStreamEvent {
  data: {
    /**
     * The call a relayed request serves: the task or workflow call whose run, or whose child
     * session, asks. The request retains its origin coordinates. Absent for the
     * session's own requests, whose approvals name their call in `request.action`.
     */
    callId?: string;
    requests: readonly InputRequest[];
    sequence: number;
    stepIndex: number;
    /** The task that asks, when the request comes from a task's run. */
    taskId?: string;
    turnId: string;
  };
  type: "input.requested";
}

/** Authoritative terminal outcome for one human-input request. */
export type InputResolutionOutcome =
  | "answered"
  | "approved"
  | "cancelled"
  | "denied"
  | "ignored"
  | "invalid";

/** One server-accepted resolution from a pending human-input batch. */
export interface InputResolution {
  readonly kind: InputRequest["kind"];
  readonly outcome: InputResolutionOutcome;
  readonly requestId: string;
  readonly response?: InputResponse;
}

/**
 * Stream event emitted after eve accepts a terminal resolution for one or more
 * pending human-input requests.
 */
export interface InputResolvedStreamEvent {
  data: {
    resolutions: readonly InputResolution[];
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "input.resolved";
}

/**
 * Stream event emitted for each runtime action result projected back into the
 * session loop.
 */
export interface ActionResultStreamEvent {
  data: {
    error?: ActionResultError;
    presentation?: ActionPresentationByCallId;
    result: RuntimeActionResult;
    sequence: number;
    stepIndex: number;
    status: ActionResultStatus;
    turnId: string;
  };
  type: "action.result";
}

/**
 * Stream event emitted for a preliminary snapshot from a locally executed
 * tool generator. The final snapshot is emitted as `action.result`.
 */
export interface ActionPartialStreamEvent {
  data: {
    presentation?: ActionPresentationByCallId;
    result: RuntimeToolResultActionResult;
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "action.partial";
}

/**
 * Stream event emitted when a workflow run opens a session with `ctx.agent`.
 * `callId` and `turnId` name the tool call whose run opened it; follow the
 * session with `session.agent(event).stream()`. For a task's run it comes
 * after that call's `task.started`.
 */
export interface AgentStartedStreamEvent {
  data: {
    callId: string;
    /** The turn of the call whose run opened the session. */
    turnId: string;
    /** The task whose run opened the session; absent when an `execute` call opened it. */
    taskId?: string;
    name: string;
    /** The opened session's id. */
    sessionId: string;
    /** A local session's stream route, or the parent-origin proxy for a remote one. */
    streamPath: string;
    /**
     * Where a remote session runs, read by the parent's stream proxy.
     * `resolverId` keys the authored credential functions (`auth` and
     * `headers`): a static agent's node id, or a dynamic agent's
     * `credentialsStepId`. The event is persisted and streamed to clients, so
     * it carries this key, never resolved header values.
     */
    remote?: {
      resolverId?: string;
      url: string;
    };
  };
  type: "agent.started";
}

/**
 * Stream event emitted when a call starts a task. `(taskId, callId)`
 * identifies the call; `callId` is the tool call clients attach status to.
 * It comes before every event the task's run causes for the call, such as
 * `agent.started` and the call's `task.settled`.
 */
export interface TaskStartedStreamEvent {
  data: {
    callId: string;
    /**
     * `"agent"` for a subagent's generated tool, local or remote; `"tool"`
     * for an authored tool, including one that opens sessions with
     * `ctx.agent`. An agent call that fails before its session opens has no
     * `agent.started`, so this is how a client tells it is an agent call.
     */
    kind: "agent" | "tool";
    /** The tool whose call started the task. */
    name: string;
    taskId: string;
    turnId: string;
  };
  type: "task.started";
}

/**
 * Stream event emitted once when a task's call settles: by the run's return
 * or failure, or by a cancel. `turnId`, `name`, and `kind` are the same as on
 * the call's `task.started`.
 */
export interface TaskSettledStreamEvent {
  data: {
    callId: string;
    /**
     * Why the call was cancelled; present only when `status` is `"cancelled"`
     * and the session stopped it. Absent when the task's run stopped on its
     * own, and on events recorded by eve versions before it was added.
     */
    cancel?: { reason: TaskCancelReason };
    /** Why the call failed; present only when `status` is `"failed"`. */
    error?: { message: string };
    /**
     * The task's kind, as on `task.started`. Absent on events recorded by eve
     * versions before it was added.
     */
    kind?: TaskStartedStreamEvent["data"]["kind"];
    /**
     * The tool whose call started the task, as on `task.started`. Absent on
     * events recorded by eve versions before it was added.
     */
    name?: string;
    /** The call's result; present only when `status` is `"completed"`. */
    output?: JsonValue;
    status: "completed" | "failed" | "cancelled";
    taskId: string;
    turnId: string;
  };
  type: "task.settled";
}

/**
 * Why the session cancelled a task call: the model called `eve__task_cancel`,
 * someone cancelled the turn (or, between turns, the tasks still working), or
 * the turn ended while the task still worked.
 */
export type TaskCancelReason = "task_cancel" | "turn_cancelled" | "turn_ended";

/**
 * Stream event emitted when one assistant text delta is appended to the
 * current message for the current step.
 */
export interface MessageAppendedStreamEvent {
  data: {
    messageDelta: string;
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "message.appended";
}

/**
 * Stream event emitted while the model is generating the input for one tool
 * call, before the validated call is announced via `actions.requested`.
 */
export interface ActionInputAppendedStreamEvent {
  data: {
    callId: string;
    inputTextDelta: string;
    sequence: number;
    stepIndex: number;
    toolName: string;
    turnId: string;
  };
  type: "action.input.appended";
}

/**
 * Stream event emitted when one reasoning delta is appended to the current
 * reasoning block for the current step.
 */
export interface ReasoningAppendedStreamEvent {
  data: {
    reasoningDelta: string;
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "reasoning.appended";
}

/**
 * Stream event emitted when one assistant step completes with visible text.
 *
 * Events preserve the order of the underlying model response messages. A
 * single turn may emit more than one completed assistant message when the
 * model replies before requesting a tool call. `data.finishReason` describes
 * why that assistant message boundary completed.
 */
export interface MessageCompletedStreamEvent {
  data: {
    finishReason: AssistantStepFinishReason;
    message: string;
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "message.completed";
}

/**
 * Stream event emitted when one completed reasoning block is available for the
 * current step.
 */
export interface ReasoningCompletedStreamEvent {
  data: {
    reasoning: string;
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "reasoning.completed";
}

/**
 * Stream event emitted when the harness finalized a structured result that
 * matches the requested output schema.
 */
export interface ResultCompletedStreamEvent {
  data: {
    result: JsonValue;
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "result.completed";
}

/**
 * Stream event emitted when one model call starts inside the current turn.
 */
export interface StepStartedStreamEvent {
  data: {
    readonly modelId: string;
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "step.started";
}

/**
 * Stream event emitted when one model call completes successfully.
 */
export interface StepCompletedStreamEvent {
  data: {
    finishReason: AssistantStepFinishReason;
    providerMetadata?: StepCompletedProviderMetadata;
    sequence: number;
    stepIndex: number;
    turnId: string;
    usage?: {
      readonly costUsd?: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
    };
  };
  type: "step.completed";
}

/**
 * Stream event emitted when one model call fails.
 */
export interface StepFailedStreamEvent {
  data: {
    code: string;
    details?: JsonObject;
    message: string;
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "step.failed";
}

/**
 * Stream event emitted when one turn reaches a terminal successful outcome.
 */
export interface TurnCompletedStreamEvent {
  data: {
    sequence: number;
    turnId: string;
  };
  type: "turn.completed";
}

/** What an open turn waits on when it parks; see {@link TurnWaitingStreamEvent}. */
export type TurnWaitingOn = "input" | "tasks";

/**
 * Stream event emitted each time an open turn parks, such as when a call it is
 * running asks a question. The turn stays open: the next `step.started` with
 * the same `turnId` means it resumed, and only `turn.completed`,
 * `turn.failed`, or `turn.cancelled` end it.
 */
export interface TurnWaitingStreamEvent {
  data: {
    /**
     * What the turn waits on. `"input"`: a person must act on a sign-in,
     * approval, or question; clients stop reading here. `"tasks"`: work the
     * turn started is still running, and the turn resumes on its own.
     */
    on: TurnWaitingOn;
    sequence: number;
    turnId: string;
    /**
     * The session's token usage so far: its own model calls plus what the
     * agents it delegated to spent. `costUsd` is absent when no model call
     * reported a cost. Absent on events from eve versions before it was added.
     */
    usage?: TokenUsage;
  };
  type: "turn.waiting";
}

/**
 * Stream event emitted when one turn fails.
 */
export interface TurnFailedStreamEvent {
  data: {
    code: string;
    details?: JsonObject;
    message: string;
    sequence: number;
    turnId: string;
  };
  type: "turn.failed";
}

/**
 * Stream event emitted when one turn is cancelled before reaching a
 * terminal outcome. Cancellation is not failure: the turn ends without
 * `turn.failed`/`session.failed`, is followed by `session.waiting`, and
 * the session accepts the next message normally.
 */
export interface TurnCancelledStreamEvent {
  data: {
    sequence: number;
    turnId: string;
  };
  type: "turn.cancelled";
}

/**
 * Stream event emitted after the durable model-message history is cleared.
 * The session itself and its non-message state remain active.
 */
export interface ContextClearedStreamEvent {
  data: {
    sequence: number;
    sessionId: string;
    turnId: string;
  };
  type: "context.cleared";
}

/**
 * Stream event emitted when the workflow decides to compact the current
 * visible session history before the next model fragment runs.
 */
export interface CompactionRequestedStreamEvent {
  data: {
    modelId: string;
    sequence: number;
    sessionId: string;
    stepIndex: number;
    turnId: string;
    usageInputTokens: number | null;
  };
  type: "compaction.requested";
}

/**
 * Stream event emitted after one compaction checkpoint message has been
 * appended to the durable session history.
 */
export interface CompactionCompletedStreamEvent {
  data: {
    modelId: string;
    sequence: number;
    sessionId: string;
    stepIndex: number;
    turnId: string;
  };
  type: "compaction.completed";
}

/**
 * Stream event emitted when a connection or tool needs user authorization
 * before it can continue.
 */
export interface AuthorizationRequiredStreamEvent {
  data: {
    /** Stable identity of this exact authorization attempt. */
    attemptId?: string;
    authorization?: ConnectionAuthorizationChallenge;
    candidateId?: string;
    description: string;
    name: string;
    /**
     * Session principal that started this sign-in, matching `responderPrincipalId`
     * on approval events. Channels use it to deliver the challenge privately.
     */
    principalId?: string;
    sequence: number;
    stepIndex: number;
    /** The task that needs the sign-in, when it comes from a task's run. */
    taskId?: string;
    turnId: string;
    webhookUrl?: string;
  };
  type: "authorization.required";
}

/**
 * Outcome of one completed authorization attempt, emitted on
 * {@link AuthorizationCompletedStreamEvent}.
 */
export type AuthorizationOutcome = "authorized" | "declined" | "failed" | "timed-out";

/**
 * @deprecated Use {@link AuthorizationOutcome}.
 */
export type ConnectionAuthorizationOutcome = AuthorizationOutcome;

/**
 * Stream event emitted once `completeAuthorization` has resolved
 * (successfully or otherwise) for one pending authorization. Carries a
 * stable `outcome` plus an optional human-readable `reason`.
 *
 * Emitted when the tool completes authorization on resume, before the
 * model's next fragment streams in.
 */
export interface AuthorizationCompletedStreamEvent {
  data: {
    /** Stable identity shared with the matching required event. */
    attemptId?: string;
    candidateId?: string;
    /**
     * The challenge from the matching `authorization.required` event,
     * journaled across the park. Lets channels keep rendering the
     * challenge's `displayName` in completion status text.
     */
    authorization?: ConnectionAuthorizationChallenge;
    name: string;
    outcome: AuthorizationOutcome;
    /** Session principal that started the matching sign-in. */
    principalId?: string;
    reason?: string;
    sequence: number;
    stepIndex: number;
    /** The task that needed the sign-in, when it comes from a task's run. */
    taskId?: string;
    turnId: string;
  };
  type: "authorization.completed";
}

/**
 * Stream event emitted when the session parks waiting for the next user
 * message.
 */
export interface SessionWaitingStreamEvent {
  data: {
    /** Channel-local continuation token, or the immutable session ID for an ID-only session. */
    continuationToken: string;
    /**
     * The session's token usage so far: its own model calls plus what the
     * agents it delegated to spent. `costUsd` is absent when no model call
     * reported a cost. Absent on events from eve versions before it was added.
     */
    usage?: TokenUsage;
    wait: "next-user-message";
  };
  type: "session.waiting";
}

/**
 * Stream event emitted when the session fails.
 */
export interface SessionFailedStreamEvent {
  data: {
    code: string;
    details?: JsonObject;
    message: string;
    sessionId: string;
    /**
     * The session's token usage so far: its own model calls plus what the
     * agents it delegated to spent. `costUsd` is absent when no model call
     * reported a cost. Absent on events from eve versions before it was added.
     */
    usage?: TokenUsage;
  };
  type: "session.failed";
}

/**
 * Stream event emitted when the session completes successfully.
 */
export interface SessionCompletedStreamEvent {
  /** Absent when the session's usage was unknown, and on events from eve versions before it was added. */
  data?: {
    /**
     * The session's token usage: its own model calls plus what the agents it
     * delegated to spent. `costUsd` is absent when no model call reported a cost.
     */
    usage: TokenUsage;
  };
  type: "session.completed";
}

/**
 * Serializable event before eve stamps the durable stream envelope.
 *
 * Internal emitters use this type while constructing events. Public stream
 * consumers receive {@link MessageStreamEvent}.
 */
export type UnstampedMessageStreamEvent =
  | ActionInputAppendedStreamEvent
  | AgentStartedStreamEvent
  | ApprovalCandidateStreamEvent
  | ApprovalSettledStreamEvent
  | ContextClearedStreamEvent
  | CompactionCompletedStreamEvent
  | CompactionRequestedStreamEvent
  | AuthorizationCompletedStreamEvent
  | AuthorizationRequiredStreamEvent
  | MessageAppendedStreamEvent
  | MessageCompletedStreamEvent
  | MessageReceivedStreamEvent
  | ReasoningAppendedStreamEvent
  | SessionCompletedStreamEvent
  | SessionFailedStreamEvent
  | SessionStartedStreamEvent
  | SessionWaitingStreamEvent
  | ResultCompletedStreamEvent
  | TaskSettledStreamEvent
  | TaskStartedStreamEvent
  | ActionsRequestedStreamEvent
  | InputRequestedStreamEvent
  | InputResolvedStreamEvent
  | ActionPartialStreamEvent
  | ActionResultStreamEvent
  | ReasoningCompletedStreamEvent
  | StepCompletedStreamEvent
  | StepFailedStreamEvent
  | StepStartedStreamEvent
  | TurnCancelledStreamEvent
  | TurnCompletedStreamEvent
  | TurnFailedStreamEvent
  | TurnStartedStreamEvent
  | TurnWaitingStreamEvent;

/**
 * Stream events that represent an unrecovered turn/session failure.
 */
export type TurnFailureStreamEvent =
  | SessionFailedStreamEvent
  | StepFailedStreamEvent
  | TurnFailedStreamEvent;

/**
 * One event read from an eve session stream.
 *
 * eve stamps the durable identity and emission time before writing the event.
 */
export type MessageStreamEvent = UnstampedMessageStreamEvent & {
  readonly meta: MessageStreamEventMeta;
};

/**
 * @deprecated Use {@link MessageStreamEvent}.
 */
export type HandleMessageStreamEvent = MessageStreamEvent;

/**
 * Returns true when the current stream has reached a turn boundary or terminal
 * session outcome.
 */
export function isCurrentTurnBoundaryEvent(event: UnstampedMessageStreamEvent): boolean {
  return (
    event.type === "session.completed" ||
    event.type === "session.failed" ||
    event.type === "session.waiting"
  );
}

/**
 * Narrows a stream event to the failure events that terminate or poison a turn.
 *
 * Generic so narrowing keeps the input's stamping: a
 * {@link MessageStreamEvent} narrows to a stamped failure event.
 */
export function isTurnFailureEvent<TEvent extends UnstampedMessageStreamEvent>(
  event: TEvent,
): event is TEvent & TurnFailureStreamEvent {
  return (
    event.type === "session.failed" || event.type === "step.failed" || event.type === "turn.failed"
  );
}
