import type { UserContent } from "ai";

import {
  createEveSessionStreamRoutePath,
  createEveSubagentStreamRoutePath,
} from "#protocol/routes.js";
import type { ConnectionAuthorizationChallenge } from "#connections/errors.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

export const EVE_SESSION_ID_HEADER = "x-eve-session-id";
export const EVE_STREAM_FORMAT_HEADER = "x-eve-stream-format";
export const EVE_STREAM_TAIL_INDEX_HEADER = "x-eve-stream-tail-index";
export const EVE_STREAM_VERSION_HEADER = "x-eve-stream-version";
export const EVE_MESSAGE_STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
export const EVE_MESSAGE_STREAM_FORMAT = "ndjson";
export const EVE_MESSAGE_STREAM_VERSION = "27";

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
 * The v26 event types that still ride inside v27 lines: tasks, child links, human input, and
 * sign-ins. Their families move to v27 facts in the next slice; until then producers build them
 * here and readers fold them beside the v27 facts.
 */
export type WorkStreamEvent =
  | AgentStartedStreamEvent
  | ApprovalCandidateStreamEvent
  | ApprovalSettledStreamEvent
  | AuthorizationCompletedStreamEvent
  | AuthorizationRequiredStreamEvent
  | InputRequestedStreamEvent
  | InputResolvedStreamEvent
  | TaskSettledStreamEvent
  | TaskStartedStreamEvent;

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
  readonly principalId?: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly taskId?: string;
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
  if (input.principalId !== undefined) {
    data.principalId = input.principalId;
  }
  if (input.webhookUrl !== undefined) {
    data.webhookUrl = input.webhookUrl;
  }
  if (input.taskId !== undefined) {
    data.taskId = input.taskId;
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
  readonly principalId?: string;
  readonly reason?: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly taskId?: string;
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
  if (input.principalId !== undefined) {
    data.principalId = input.principalId;
  }
  if (input.reason !== undefined) {
    data.reason = input.reason;
  }
  if (input.taskId !== undefined) {
    data.taskId = input.taskId;
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
  readonly callId?: string;
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
  if (input.callId !== undefined) data.callId = input.callId;
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

/** Creates the `task.started` event for one call that starts a task. */
export function createTaskStartedEvent(
  input: TaskStartedStreamEvent["data"],
): TaskStartedStreamEvent {
  return {
    data: {
      callId: input.callId,
      kind: input.kind,
      name: input.name,
      taskId: input.taskId,
      turnId: input.turnId,
    },
    type: "task.started",
  };
}

/** Creates the `task.settled` event for one settled task call. */
export function createTaskSettledEvent(
  input: TaskSettledStreamEvent["data"],
): TaskSettledStreamEvent {
  const data: TaskSettledStreamEvent["data"] = {
    callId: input.callId,
    ...(input.kind !== undefined && { kind: input.kind }),
    ...(input.name !== undefined && { name: input.name }),
    status: input.status,
    taskId: input.taskId,
    turnId: input.turnId,
  };
  if (input.output !== undefined) data.output = input.output;
  if (input.error !== undefined) data.error = input.error;
  if (input.cancel !== undefined) data.cancel = input.cancel;
  return { data, type: "task.settled" };
}

/**
 * Creates the `agent.started` event for one session a workflow run opened.
 */
export function createAgentStartedEvent(input: {
  readonly callId: string;
  readonly name: string;
  readonly parentSessionId: string;
  readonly remote?: {
    readonly resolverId?: string;
    readonly url: string;
  };
  readonly sessionId: string;
  readonly taskId?: string;
  readonly turnId: string;
}): AgentStartedStreamEvent {
  const data: AgentStartedStreamEvent["data"] = {
    callId: input.callId,
    turnId: input.turnId,
    name: input.name,
    sessionId: input.sessionId,
    streamPath: createEveSessionStreamRoutePath(input.sessionId),
  };
  if (input.taskId !== undefined) data.taskId = input.taskId;
  if (input.remote !== undefined) {
    data.remote = input.remote;
    data.streamPath = createEveSubagentStreamRoutePath({
      callId: input.callId,
      childSessionId: input.sessionId,
      parentSessionId: input.parentSessionId,
    });
  }
  return { data, type: "agent.started" };
}
