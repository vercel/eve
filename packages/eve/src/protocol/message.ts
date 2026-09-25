import type { FileUIPart, ProviderMetadata, TextUIPart, UserContent } from "ai";

import {
  deserializeUrlFilePart,
  hasInternalRefScheme,
  isSerializedUrlFilePart,
} from "#internal/attachments/url-refs.js";
import { decodeSandboxRef, isSandboxRefUrl } from "#internal/attachments/sandbox-refs.js";
import { createEventId } from "#protocol/event-id.js";
import {
  createEveSessionStreamRoutePath,
  createEveSubagentStreamRoutePath,
} from "#protocol/routes.js";
import type { ConnectionAuthorizationChallenge } from "#connections/errors.js";
import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeToolResultActionResult,
} from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import { toChannelLocalContinuationToken } from "#shared/continuation-token.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

export const EVE_SESSION_ID_HEADER = "x-eve-session-id";
export const EVE_STREAM_FORMAT_HEADER = "x-eve-stream-format";
export const EVE_STREAM_TAIL_INDEX_HEADER = "x-eve-stream-tail-index";
export const EVE_STREAM_VERSION_HEADER = "x-eve-stream-version";
/** Health route response header reporting the deployment's task protocol version. */
export const EVE_TASK_PROTOCOL_HEADER = "x-eve-task-protocol";
/** Request header of a report read: the callback token the report was sent to. */
export const EVE_CALLBACK_TOKEN_HEADER = "x-eve-callback-token";
export const EVE_MESSAGE_STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
export const EVE_MESSAGE_STREAM_FORMAT = "ndjson";
/**
 * Schema version of the session stream. The published task stream fixtures
 * under `conformance/task-streams/` record it, so a change regenerates them
 * (`EVE_UPDATE_TASK_STREAM_FIXTURES=1` on their scenario test).
 */
export const EVE_MESSAGE_STREAM_VERSION = "25";

/** Version of transport control records understood by this eve release. */
export const EVE_STREAM_CONTROL_VERSION = "1";
export const EVE_STREAM_CONTROL_VERSION_QUERY = "streamControlVersion";
/** Internal record emitted when a leased HTTP response should be renewed. */
export const EVE_STREAM_LEASE_ENDED_CONTROL = {
  $eve: "stream.lease-ended",
  version: 1,
} as const;

/**
 * eve-owned finish reason for one completed assistant step.
 *
 * `tool-calls` is the only non-terminal assistant step in the current
 * tool-loop harness. All other values indicate the assistant step ended the
 * current turn.
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
    /**
     * Present when eve authored the input instead of a channel participant.
     * `task.result` delivers background task results to the model; clients
     * must not render it as a user message.
     */
    kind?: "task.result";
    message: string;
    parts?: readonly MessageReceivedPart[];
    sequence: number;
    /** With `kind: "task.result"`: the tasks whose results the message delivers. */
    taskIds?: readonly string[];
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
    /** Set when a delegated task's approval is proxied; the approval belongs to that task. */
    taskId?: string;
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
    /** Set when a delegated task's approval is proxied; the approval belongs to that task. */
    taskId?: string;
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
    requests: readonly InputRequest[];
    sequence: number;
    stepIndex: number;
    /** Set when a delegated task asked; the requests belong to that task. */
    taskId?: string;
    turnId: string;
  };
  type: "input.requested";
}

/** Authoritative terminal outcome for one human-input request. */
export type InputResolutionOutcome = "answered" | "approved" | "denied" | "ignored" | "invalid";

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

/** The child session a task runs in, and where a client can follow its stream. */
export interface TaskChildStream {
  sessionId: string;
  /**
   * Route on this deployment that streams the child session. For a remote
   * child it is a parent-origin proxy, which the parent authenticates to the
   * remote deployment. Follow it with `session.streamSubagent()`.
   */
  streamPath: string;
  /** Set when the child runs on another deployment. */
  remote?: {
    /**
     * Key to the authored credential functions (`auth`/`headers`) for this
     * remote child, resolved at stream-proxy time by
     * `resolveRemoteAgentStreamHeaders`. Static subagent → the node id in
     * `subagentRegistry.subagentsByNodeId`; dynamic subagent → its
     * `credentialsStepId` in the step registry. The event stores this key —
     * never resolved header values — because tokens expire and this event
     * is persisted and streamed to clients. Absent when the remote child
     * has no authored credentials.
     */
    resolverId?: string;
    url: string;
  };
}

/** Token usage one task generation reported when it settled. */
export interface TaskUsage {
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Stream event emitted exactly once per task generation, when it starts.
 * Every task follows one lifecycle: `task.started` then `task.settled` for
 * each generation, in order, and one `task.ended` after the last. `taskId`
 * is stable across the task's generations; `callId` identifies the call that
 * started this generation: the task's start, or a send with its `taskId`.
 */
export interface TaskStartedStreamEvent {
  data: {
    callId: string;
    /**
     * The child session to follow. Absent for a workflow tool task, and for a
     * generation that failed before its child started.
     */
    child?: TaskChildStream;
    /** Counts from 1; each send that starts more work on the task adds one. */
    generation: number;
    kind: "agent" | "workflow";
    /**
     * `detached`: the call returned a receipt and the task keeps working on
     * its own. `attached`: the calling turn, or a workflow body, awaits it.
     */
    mode: "attached" | "detached";
    name: string;
    /** The task takes more input by `taskId`: every agent, and `resumable: true` workflow tools. */
    resumable: boolean;
    taskId: string;
    turnId: string;
  };
  type: "task.started";
}

/**
 * Stream event emitted exactly once per task generation, after its
 * `task.started`, with the generation's first terminal outcome.
 */
export interface TaskSettledStreamEvent {
  data: {
    callId: string;
    /** Present when `status` is `failed`. Consumers must handle unknown codes. */
    error?: { code: string; message: string };
    /** Present when `status` is `completed`. */
    output?: JsonValue;
    generation: number;
    status: "completed" | "failed" | "cancelled";
    taskId: string;
    /** Present when the child reported the generation's usage. */
    usage?: TaskUsage;
  };
  type: "task.settled";
}

/**
 * Stream event emitted exactly once per task, after its last `task.settled`,
 * when the task stops taking input: right after a non-resumable task's only
 * generation, and when a resumable task's body returns, it is retired, it is
 * stopped for good, or its session ends. A finished task is one that ended.
 */
export interface TaskEndedStreamEvent {
  data: {
    taskId: string;
  };
  type: "task.ended";
}

/**
 * Stream event (`type: "subagent.event"`) wrapping one child stream event
 * produced by an inline subagent, under `data.event`, tagged with the
 * originating `data.callId` and `data.subagentName`.
 */
export interface SubagentChildEventStreamEvent {
  data: {
    callId: string;
    event: UnstampedMessageStreamEvent;
    subagentName: string;
  };
  type: "subagent.event";
}

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
    /**
     * The message is not the turn's reply yet: the turn holds on tasks it
     * started, and eve calls the model again once one settles. Set only where
     * a held turn shows no waiting boundary (a scheduled turn, a subagent's
     * turn, or a task-mode run); an interactive session's held turn instead
     * ends its message with `turn.completed` carrying `held: true`.
     */
    interim?: true;
    message: string | null;
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
 * Stream event emitted when one turn reaches a terminal successful outcome,
 * or a waiting boundary that keeps it open (`held`).
 */
export interface TurnCompletedStreamEvent {
  data: {
    /**
     * The turn did not end: it holds on tasks it started, or waits on a
     * task's question, and resumes under the same `turnId` when a result or
     * the same person's message arrives. The `session.waiting` that follows
     * is a waiting boundary, not the turn's end.
     */
    held?: true;
    sequence: number;
    turnId: string;
  };
  type: "turn.completed";
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
    sequence: number;
    stepIndex: number;
    /** Set when a delegated task needs the authorization. */
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
    reason?: string;
    sequence: number;
    stepIndex: number;
    /** Set when a delegated task needed the authorization. */
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
  };
  type: "session.failed";
}

/**
 * Stream event emitted when the session completes successfully.
 */
export interface SessionCompletedStreamEvent {
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
  | SubagentChildEventStreamEvent
  | TaskEndedStreamEvent
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
  | TurnStartedStreamEvent;

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

const textEncoder = new TextEncoder();

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

/**
 * Creates the `session.started` event for one session.
 */
export function createSessionStartedEvent(input?: {
  readonly invocation?: SubagentSessionInvocationMetadata;
  readonly runtime?: RuntimeIdentity;
  readonly trace?: RuntimeTraceContext;
}): SessionStartedStreamEvent {
  const data: SessionStartedStreamEvent["data"] = {};

  if (input?.invocation !== undefined) {
    data.invocation = input.invocation;
  }

  if (input?.runtime !== undefined) {
    data.runtime = input.runtime;
  }

  if (input?.trace !== undefined) {
    data.trace = input.trace;
  }

  return {
    data,
    type: "session.started",
  };
}

/**
 * Creates the `turn.started` event for one prepared runtime turn.
 */
export function createTurnStartedEvent(input: {
  readonly sequence: number;
  readonly trace?: RuntimeTraceContext;
  readonly turnId: string;
}): TurnStartedStreamEvent {
  const data: TurnStartedStreamEvent["data"] = {
    sequence: input.sequence,
    turnId: input.turnId,
  };

  if (input.trace !== undefined) {
    data.trace = input.trace;
  }

  return {
    data,
    type: "turn.started",
  };
}

/**
 * Creates the `message.received` event for one normalized user message.
 *
 * When the message is a structured `UserContent` array (e.g. text + file
 * parts), the event surfaces a text summary: concatenated text parts with
 * `[file: filename (mediaType)]` placeholders for non-text parts. This
 * keeps the wire event as a simple string for dev-REPL and web
 * consumers while preserving the authored turn content upstream.
 */
export function createMessageReceivedEvent(input: {
  readonly message: string | UserContent;
  readonly sequence: number;
  /** Task results delivered by eve rather than a channel participant. */
  readonly taskIds?: readonly string[];
  readonly turnId: string;
}): MessageReceivedStreamEvent {
  const event: MessageReceivedStreamEvent = {
    data: {
      message: summarizeUserContent(input.message),
      parts: projectUserContentParts(input.message),
      sequence: input.sequence,
      turnId: input.turnId,
    },
    type: "message.received",
  };
  if (input.taskIds === undefined) return event;
  return { ...event, data: { ...event.data, kind: "task.result", taskIds: [...input.taskIds] } };
}

function summarizeUserContent(message: string | UserContent): string {
  if (typeof message === "string") {
    return message;
  }

  const pieces: string[] = [];
  for (const part of message) {
    if (part.type === "text") {
      pieces.push(part.text);
    } else if (part.type === "file") {
      const label = part.filename ?? part.mediaType;
      pieces.push(`[file: ${label} (${part.mediaType})]`);
    } else if (part.type === "image") {
      pieces.push(`[image: ${part.mediaType ?? "image"}]`);
    }
  }
  return pieces.join("\n");
}

const PROJECTED_PART_FALLBACK_MEDIA_TYPE = "application/octet-stream";

function projectUserContentParts(message: string | UserContent): readonly MessageReceivedPart[] {
  if (typeof message === "string") {
    return [{ text: message, type: "text" }];
  }

  const parts: MessageReceivedPart[] = [];
  for (const part of message) {
    if (part.type === "text") {
      parts.push({ text: part.text, type: "text" });
    } else if (part.type === "file") {
      parts.push(projectFileLikePart(part.data, part.mediaType, part.filename));
    } else if (part.type === "image") {
      parts.push(
        projectFileLikePart(
          part.image,
          part.mediaType ?? PROJECTED_PART_FALLBACK_MEDIA_TYPE,
          undefined,
        ),
      );
    }
  }
  return parts;
}

function projectFileLikePart(
  data: unknown,
  mediaType: string,
  filename: string | undefined,
): MessageReceivedPart {
  if (isSandboxRefUrl(data)) {
    const ref = decodeSandboxRef(data);
    return createProjectedFilePart({
      filename: basenameOf(filename ?? ref.path),
      mediaType: ref.mediaType,
      size: ref.size,
    });
  }

  const tagged = projectTaggedFileData(data, mediaType, filename);
  if (tagged !== undefined) {
    return tagged;
  }

  const size = byteLengthOf(data);
  if (size !== undefined) {
    return createProjectedFilePart({ filename, mediaType, size });
  }

  return createProjectedFilePart({ filename, mediaType, ...clientUrlFragment(data) });
}

function projectTaggedFileData(
  data: unknown,
  mediaType: string,
  filename: string | undefined,
): MessageReceivedPart | undefined {
  if (!isTaggedFileData(data)) {
    return undefined;
  }

  switch (data.type) {
    case "data": {
      const size = byteLengthOf(data.data);
      return size === undefined
        ? createProjectedFilePart({ filename, mediaType })
        : createProjectedFilePart({ filename, mediaType, size });
    }
    case "reference":
    case "text":
      return createProjectedFilePart({ filename, mediaType });
    case "url":
      return createProjectedFilePart({ filename, mediaType, ...clientUrlFragment(data.url) });
  }
}

function createProjectedFilePart(input: {
  readonly filename?: string;
  readonly mediaType: string;
  readonly size?: number;
  readonly url?: string;
}): MessageReceivedPart {
  const part: {
    filename?: string;
    mediaType: string;
    size?: number;
    type: "file";
    url?: string;
  } = {
    mediaType: input.mediaType,
    type: "file",
  };
  if (input.filename !== undefined) {
    part.filename = input.filename;
  }
  if (input.size !== undefined) {
    part.size = input.size;
  }
  if (input.url !== undefined) {
    part.url = input.url;
  }
  return part;
}

function isTaggedFileData(
  data: unknown,
): data is
  | { readonly type: "data"; readonly data: unknown }
  | { readonly type: "reference"; readonly reference: unknown }
  | { readonly type: "text"; readonly text: unknown }
  | { readonly type: "url"; readonly url: unknown } {
  if (data === null || typeof data !== "object") {
    return false;
  }
  const type = (data as { readonly type?: unknown }).type;
  return type === "data" || type === "reference" || type === "text" || type === "url";
}

function byteLengthOf(data: unknown): number | undefined {
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  return undefined;
}

function clientUrlFragment(data: unknown): { readonly url?: string } {
  if (isSerializedUrlFilePart(data)) {
    try {
      const url = deserializeUrlFilePart(data);
      return isClientResolvableUrl(url) ? { url: url.href } : {};
    } catch {
      return {};
    }
  }

  if (data instanceof URL) {
    return isClientResolvableUrl(data) ? { url: data.href } : {};
  }

  if (typeof data !== "string" || hasInternalRefScheme(data)) {
    return {};
  }

  if (data.startsWith("data:")) {
    return { url: data };
  }

  try {
    const url = new URL(data);
    return isClientResolvableUrl(url) ? { url: url.href } : {};
  } catch {
    return {};
  }
}

function isClientResolvableUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:";
}

function basenameOf(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segment = normalized.slice(normalized.lastIndexOf("/") + 1);
  return segment.length > 0 ? segment : path;
}

/**
 * Creates the `actions.requested` event for one observed group of model action
 * requests.
 */
export function createActionsRequestedEvent(input: {
  readonly actions: readonly RuntimeActionRequest[];
  readonly presentation?: ActionPresentationByCallId;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): ActionsRequestedStreamEvent {
  return {
    data: {
      actions: input.actions,
      ...optionalPresentation(input.presentation),
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      turnId: input.turnId,
    },
    type: "actions.requested",
  };
}

function optionalPresentation(presentation: ActionPresentationByCallId | undefined): {
  readonly presentation?: ActionPresentationByCallId;
} {
  return presentation === undefined ? {} : { presentation };
}

/** Creates an `action.input.appended` event for streamed tool input text. */
export function createActionInputAppendedEvent(input: {
  readonly callId: string;
  readonly inputTextDelta: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly toolName: string;
  readonly turnId: string;
}): ActionInputAppendedStreamEvent {
  return {
    data: {
      callId: input.callId,
      inputTextDelta: input.inputTextDelta,
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      turnId: input.turnId,
    },
    type: "action.input.appended",
  };
}

/**
 * Creates the `authorization.required` event for one authorization source
 * that needs user authorization before it can continue.
 *
 * `authorization` and `webhookUrl` are present together when the runtime
 * has suspended the turn on a framework-owned webhook; both are absent
 * for `getToken`-only authorization sources that authorize out of band.
 */
export function createAuthorizationRequiredEvent(input: {
  readonly attemptId?: string;
  readonly authorization?: ConnectionAuthorizationChallenge;
  readonly candidateId?: string;
  readonly description: string;
  readonly name: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
  readonly webhookUrl?: string;
}): AuthorizationRequiredStreamEvent {
  const data: AuthorizationRequiredStreamEvent["data"] = {
    description: input.description,
    name: input.name,
    sequence: input.sequence,
    stepIndex: input.stepIndex,
    turnId: input.turnId,
  };
  if (input.attemptId !== undefined) {
    data.attemptId = input.attemptId;
  }
  if (input.authorization !== undefined) {
    data.authorization = input.authorization;
  }
  if (input.candidateId !== undefined) {
    data.candidateId = input.candidateId;
  }
  if (input.webhookUrl !== undefined) {
    data.webhookUrl = input.webhookUrl;
  }
  return {
    data,
    type: "authorization.required",
  };
}

/**
 * Creates the `authorization.completed` event emitted once per
 * authorization source after `completeAuthorization` has resolved or the
 * authorization deadline has expired.
 */
export function createAuthorizationCompletedEvent(input: {
  readonly attemptId?: string;
  readonly authorization?: ConnectionAuthorizationChallenge;
  readonly candidateId?: string;
  readonly name: string;
  readonly outcome: AuthorizationOutcome;
  readonly reason?: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): AuthorizationCompletedStreamEvent {
  const data: AuthorizationCompletedStreamEvent["data"] = {
    name: input.name,
    outcome: input.outcome,
    sequence: input.sequence,
    stepIndex: input.stepIndex,
    turnId: input.turnId,
  };
  if (input.attemptId !== undefined) {
    data.attemptId = input.attemptId;
  }
  if (input.authorization !== undefined) {
    data.authorization = input.authorization;
  }
  if (input.candidateId !== undefined) {
    data.candidateId = input.candidateId;
  }
  if (input.reason !== undefined) {
    data.reason = input.reason;
  }
  return {
    data,
    type: "authorization.completed",
  };
}

/** Creates a safe candidate lifecycle event. */
export function createApprovalCandidateEvent(
  input: ApprovalCandidateStreamEvent["data"],
): ApprovalCandidateStreamEvent {
  return { data: input, type: "approval.candidate" };
}

/** Creates a terminal approval settlement event. */
export function createApprovalSettledEvent(
  input: ApprovalSettledStreamEvent["data"],
): ApprovalSettledStreamEvent {
  return { data: input, type: "approval.settled" };
}

/**
 * Creates the `input.requested` event for one pending HITL batch.
 */
export function createInputRequestedEvent(input: {
  readonly requests: readonly InputRequest[];
  readonly sequence: number;
  readonly stepIndex: number;
  readonly taskId?: string;
  readonly turnId: string;
}): InputRequestedStreamEvent {
  const data: InputRequestedStreamEvent["data"] = {
    requests: input.requests,
    sequence: input.sequence,
    stepIndex: input.stepIndex,
    turnId: input.turnId,
  };
  if (input.taskId !== undefined) data.taskId = input.taskId;
  return { data, type: "input.requested" };
}

/** Creates the authoritative `input.resolved` event for one pending HITL batch. */
export function createInputResolvedEvent(input: {
  readonly resolutions: readonly InputResolution[];
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): InputResolvedStreamEvent {
  return {
    data: {
      resolutions: input.resolutions,
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      turnId: input.turnId,
    },
    type: "input.resolved",
  };
}

/**
 * Creates the `action.result` event for one runtime action result.
 *
 * Pass `rejected: true` for a tool call denied at a HITL approval gate. The
 * call never executed, so the outcome is forced to `rejected` rather than
 * derived from the synthesized denial output.
 */
export function createActionResultEvent(input: {
  readonly presentation?: ActionPresentationByCallId;
  readonly rejected?: boolean;
  readonly result: RuntimeActionResult;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): ActionResultStreamEvent {
  const outcome =
    input.rejected === true
      ? { error: buildActionResultError(input.result), status: "rejected" as const }
      : normalizeActionResultOutcome(input.result);

  return {
    data: {
      error: outcome.error,
      ...optionalPresentation(input.presentation),
      result: withoutModelOutput(input.result),
      sequence: input.sequence,
      status: outcome.status,
      stepIndex: input.stepIndex,
      turnId: input.turnId,
    },
    type: "action.result",
  };
}

/** A receipt's model text is for the model; clients read its structured `output`. */
function withoutModelOutput(result: RuntimeActionResult): RuntimeActionResult {
  if (result.kind !== "tool-result" || result.modelOutput === undefined) return result;
  const { modelOutput: _modelOutput, ...rest } = result;
  return rest;
}

/** Creates an `action.partial` event for one preliminary tool-result snapshot. */
export function createActionPartialEvent(input: {
  readonly presentation?: ActionPresentationByCallId;
  readonly result: RuntimeToolResultActionResult;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): ActionPartialStreamEvent {
  return {
    data: {
      ...optionalPresentation(input.presentation),
      result: input.result,
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      turnId: input.turnId,
    },
    type: "action.partial",
  };
}

/**
 * Creates the `task.started` event for one task generation. A local child is
 * streamed from its own session route; a remote child through the parent's
 * proxy route, which the parent authenticates to the remote deployment.
 */
export function createTaskStartedEvent(input: {
  readonly callId: string;
  readonly child?: {
    readonly remote?: { readonly resolverId?: string; readonly url: string };
    readonly sessionId: string;
  };
  readonly generation: number;
  readonly kind: TaskStartedStreamEvent["data"]["kind"];
  readonly mode: TaskStartedStreamEvent["data"]["mode"];
  readonly name: string;
  readonly parentSessionId: string;
  readonly resumable: boolean;
  readonly taskId: string;
  readonly turnId: string;
}): TaskStartedStreamEvent {
  const data: TaskStartedStreamEvent["data"] = {
    callId: input.callId,
    generation: input.generation,
    kind: input.kind,
    mode: input.mode,
    name: input.name,
    resumable: input.resumable,
    taskId: input.taskId,
    turnId: input.turnId,
  };
  const { child } = input;
  if (child !== undefined) {
    data.child =
      child.remote === undefined
        ? {
            sessionId: child.sessionId,
            streamPath: createEveSessionStreamRoutePath(child.sessionId),
          }
        : {
            remote:
              child.remote.resolverId === undefined
                ? { url: child.remote.url }
                : { resolverId: child.remote.resolverId, url: child.remote.url },
            sessionId: child.sessionId,
            streamPath: createEveSubagentStreamRoutePath({
              callId: input.callId,
              childSessionId: child.sessionId,
              parentSessionId: input.parentSessionId,
            }),
          };
  }
  return { data, type: "task.started" };
}

/** Creates the `task.settled` event for one task generation's first terminal outcome. */
export function createTaskSettledEvent(
  input: {
    readonly callId: string;
    readonly generation: number;
    readonly taskId: string;
    readonly usage?: TaskUsage;
  } & (
    | { readonly status: "completed"; readonly output: JsonValue }
    | { readonly status: "failed"; readonly error: { code: string; message: string } }
    | { readonly status: "cancelled" }
  ),
): TaskSettledStreamEvent {
  const data: TaskSettledStreamEvent["data"] = {
    callId: input.callId,
    generation: input.generation,
    status: input.status,
    taskId: input.taskId,
  };
  if (input.status === "completed") data.output = input.output;
  if (input.status === "failed") {
    data.error = { code: input.error.code, message: input.error.message };
  }
  if (input.usage !== undefined) data.usage = input.usage;
  return { data, type: "task.settled" };
}

/** Creates the `task.ended` event for a task that stopped taking input. */
export function createTaskEndedEvent(taskId: string): TaskEndedStreamEvent {
  return { data: { taskId }, type: "task.ended" };
}

/**
 * Creates the `message.appended` event for one streamed assistant text delta.
 */
export function createMessageAppendedEvent(input: {
  readonly messageDelta: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): MessageAppendedStreamEvent {
  return {
    data: {
      messageDelta: input.messageDelta,
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      turnId: input.turnId,
    },
    type: "message.appended",
  };
}

/**
 * Creates the `reasoning.appended` event for one streamed reasoning delta.
 */
export function createReasoningAppendedEvent(input: {
  readonly reasoningDelta: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): ReasoningAppendedStreamEvent {
  return {
    data: {
      reasoningDelta: input.reasoningDelta,
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      turnId: input.turnId,
    },
    type: "reasoning.appended",
  };
}

/**
 * Creates the `message.completed` event for one completed assistant text chunk.
 */
export function createMessageCompletedEvent(input: {
  readonly finishReason?: AssistantStepFinishReason;
  readonly interim?: boolean;
  readonly message: string | null;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): MessageCompletedStreamEvent {
  const data: MessageCompletedStreamEvent["data"] = {
    finishReason: input.finishReason ?? "stop",
    message: input.message,
    sequence: input.sequence,
    stepIndex: input.stepIndex,
    turnId: input.turnId,
  };
  if (input.interim === true) data.interim = true;
  return { data, type: "message.completed" };
}

/**
 * Creates the `reasoning.completed` event for one completed reasoning block.
 */
export function createReasoningCompletedEvent(input: {
  readonly reasoning: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): ReasoningCompletedStreamEvent {
  return {
    data: {
      reasoning: input.reasoning,
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      turnId: input.turnId,
    },
    type: "reasoning.completed",
  };
}

/**
 * Creates the `result.completed` event for one finalized structured result.
 */
export function createResultCompletedEvent(input: {
  readonly result: JsonValue;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): ResultCompletedStreamEvent {
  return {
    data: {
      result: input.result,
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      turnId: input.turnId,
    },
    type: "result.completed",
  };
}

/**
 * Creates the `step.started` event for one model call.
 */
export function createStepStartedEvent(input: {
  readonly modelId: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): StepStartedStreamEvent {
  return {
    data: {
      modelId: input.modelId,
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      turnId: input.turnId,
    },
    type: "step.started",
  };
}

/**
 * Creates the `step.completed` event for one completed model call.
 */
export function createStepCompletedEvent(input: {
  readonly finishReason: AssistantStepFinishReason;
  readonly providerMetadata?: StepCompletedProviderMetadata;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
  readonly usage?: {
    readonly costUsd?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
}): StepCompletedStreamEvent {
  const data: StepCompletedStreamEvent["data"] = {
    finishReason: input.finishReason,
    sequence: input.sequence,
    stepIndex: input.stepIndex,
    turnId: input.turnId,
  };

  if (input.usage !== undefined) {
    data.usage = input.usage;
  }
  if (input.providerMetadata !== undefined) {
    data.providerMetadata = input.providerMetadata;
  }

  return {
    data,
    type: "step.completed",
  };
}

/**
 * Creates the `step.failed` event for one failed model call.
 */
export function createStepFailedEvent(input: {
  readonly code: string;
  readonly details?: JsonObject;
  readonly message: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): StepFailedStreamEvent {
  return {
    data: {
      code: input.code,
      details: input.details,
      message: input.message,
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      turnId: input.turnId,
    },
    type: "step.failed",
  };
}

/**
 * Creates the `turn.completed` event for one terminal successful turn, or for
 * a held turn's waiting boundary.
 */
export function createTurnCompletedEvent(input: {
  readonly held?: boolean;
  readonly sequence: number;
  readonly turnId: string;
}): TurnCompletedStreamEvent {
  const data: TurnCompletedStreamEvent["data"] = { sequence: input.sequence, turnId: input.turnId };
  if (input.held === true) data.held = true;
  return { data, type: "turn.completed" };
}

/**
 * Creates the `turn.failed` event for one failed turn.
 */
export function createTurnFailedEvent(input: {
  readonly code: string;
  readonly details?: JsonObject;
  readonly message: string;
  readonly sequence: number;
  readonly turnId: string;
}): TurnFailedStreamEvent {
  return {
    data: {
      code: input.code,
      details: input.details,
      message: input.message,
      sequence: input.sequence,
      turnId: input.turnId,
    },
    type: "turn.failed",
  };
}

/** Creates the `turn.cancelled` event for one cancelled turn. */
export function createTurnCancelledEvent(input: {
  readonly sequence: number;
  readonly turnId: string;
}): TurnCancelledStreamEvent {
  return {
    data: {
      sequence: input.sequence,
      turnId: input.turnId,
    },
    type: "turn.cancelled",
  };
}

/** Creates the `context.cleared` event for one manual history clear. */
export function createContextClearedEvent(input: {
  readonly sequence: number;
  readonly sessionId: string;
  readonly turnId: string;
}): ContextClearedStreamEvent {
  return {
    data: {
      sequence: input.sequence,
      sessionId: input.sessionId,
      turnId: input.turnId,
    },
    type: "context.cleared",
  };
}

/**
 * Creates the `compaction.requested` event for one runtime compaction pass.
 */
export function createCompactionRequestedEvent(input: {
  readonly modelId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly usageInputTokens: number | undefined;
}): CompactionRequestedStreamEvent {
  return {
    data: {
      modelId: input.modelId,
      sequence: input.sequence,
      sessionId: input.sessionId,
      turnId: input.turnId,
      usageInputTokens: input.usageInputTokens ?? null,
    },
    type: "compaction.requested",
  };
}

/**
 * Creates the `compaction.completed` event for one appended checkpoint.
 */
export function createCompactionCompletedEvent(input: {
  readonly modelId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly turnId: string;
}): CompactionCompletedStreamEvent {
  return {
    data: {
      modelId: input.modelId,
      sequence: input.sequence,
      sessionId: input.sessionId,
      turnId: input.turnId,
    },
    type: "compaction.completed",
  };
}

/**
 * Creates the `session.waiting` event for the only supported between-turn
 * wait.
 */
export function createSessionWaitingEvent(
  namespacedContinuationToken: string = "",
): SessionWaitingStreamEvent {
  return {
    data: {
      continuationToken: toChannelLocalContinuationToken(namespacedContinuationToken),
      wait: "next-user-message",
    },
    type: "session.waiting",
  };
}

/**
 * Creates the `session.failed` event for one terminal session failure.
 */
export function createSessionFailedEvent(input: {
  readonly code: string;
  readonly details?: JsonObject;
  readonly message: string;
  readonly sessionId: string;
}): SessionFailedStreamEvent {
  return {
    data: {
      code: input.code,
      details: input.details,
      message: input.message,
      sessionId: input.sessionId,
    },
    type: "session.failed",
  };
}

/**
 * Creates the `session.completed` event for one terminal session completion.
 */
export function createSessionCompletedEvent(): SessionCompletedStreamEvent {
  return { type: "session.completed" };
}

/**
 * Stamps one session event with its durable identity and emission time.
 *
 * Runtime/execution code only, once per event, immediately before the write.
 * One stamping seam is what makes the persisted stream and authored hooks
 * observe the same `meta.id`.
 */
export function stampMessageStreamEvent(
  event: UnstampedMessageStreamEvent,
  deliveryIds?: readonly string[],
): MessageStreamEvent {
  const meta: { at: string; id: string; deliveryIds?: readonly string[] } = {
    at: new Date().toISOString(),
    id: createEventId(),
  };
  if (deliveryIds !== undefined && deliveryIds.length > 0) meta.deliveryIds = deliveryIds;
  return {
    ...event,
    meta,
  };
}

/**
 * Encodes one message stream event as newline-delimited JSON.
 */
export function encodeMessageStreamEvent(event: MessageStreamEvent): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(event)}\n`);
}

function normalizeActionResultOutcome(result: RuntimeActionResult): {
  readonly error?: ActionResultError;
  readonly status: ActionResultStatus;
} {
  if (result.isError === true) {
    return {
      error: buildActionResultError(result),
      status: "failed",
    };
  }

  const outputError = readActionResultOutputError(result.output);
  if (outputError !== undefined) {
    return {
      error: outputError,
      status: "failed",
    };
  }

  return {
    status: "completed",
  };
}

function buildActionResultError(result: RuntimeActionResult): ActionResultError {
  const outputError = readActionResultOutputError(result.output);
  if (outputError !== undefined) {
    return outputError;
  }

  return {
    code: "ACTION_RESULT_FAILED",
    message: formatActionResultOutput(result.output),
  };
}

function readActionResultOutputError(output: unknown): ActionResultError | undefined {
  const record = parseActionResultOutputRecord(output);
  if (record === undefined) {
    return undefined;
  }

  const code = typeof record.code === "string" && record.code.length > 0 ? record.code : undefined;
  const message =
    typeof record.message === "string" && record.message.length > 0 ? record.message : undefined;

  if (code === undefined || message === undefined) {
    return undefined;
  }

  return {
    code,
    message,
  };
}

function parseActionResultOutputRecord(output: unknown): Record<string, unknown> | undefined {
  if (output !== null && typeof output === "object") {
    return output as Record<string, unknown>;
  }

  if (typeof output !== "string") {
    return undefined;
  }

  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function formatActionResultOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  const serialized = JSON.stringify(output);
  if (typeof serialized === "string" && serialized.length > 0) {
    return serialized;
  }

  return "Action failed.";
}
