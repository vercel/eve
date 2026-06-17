import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";
import type { UserContent } from "ai";

import type { RuntimeActionRequest, RuntimeActionResult } from "#runtime/actions/types.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

export const EVE_SESSION_ID_HEADER = "x-eve-session-id";
export const EVE_STREAM_FORMAT_HEADER = "x-eve-stream-format";
export const EVE_STREAM_VERSION_HEADER = "x-eve-stream-version";
export const EVE_MESSAGE_STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
export const EVE_MESSAGE_STREAM_FORMAT = "ndjson";
export const EVE_MESSAGE_STREAM_VERSION = "16";

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

/**
 * Durable metadata attached to one persisted session stream event.
 *
 * Runtime code stamps this immediately before writing the event to the
 * workflow-owned stream so replay preserves the original timing.
 */
export interface HandleMessageStreamEventMeta {
  readonly at: string;
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
  readonly modelId: string;
}

/**
 * JSON request accepted by the canonical message route.
 *
 * `message` is either a plain text string or an AI SDK `UserContent`
 * array (mixing `text`, `image`, and `file` parts). Clients pass
 * multimodal attachments with the same shape AI SDK's `useChat`
 * `sendMessage({ files })` produces. `clientContext` is one-turn
 * client/page context; the channel converts it into internal model context.
 */
export type HandleMessageRequestBody =
  | {
      readonly message: string | UserContent;
      readonly clientContext?: string | readonly string[] | JsonObject;
      readonly outputSchema?: JsonObject;
    }
  | {
      readonly continuationToken: string;
      readonly message: string | UserContent;
      readonly clientContext?: string | readonly string[] | JsonObject;
      readonly outputSchema?: JsonObject;
    }
  | {
      readonly continuationToken: string;
      readonly inputResponses: readonly InputResponse[];
      readonly clientContext?: string | readonly string[] | JsonObject;
      readonly outputSchema?: JsonObject;
    }
  | {
      readonly continuationToken: string;
      readonly inputResponses: readonly InputResponse[];
      readonly message: string | UserContent;
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
  };
  type: "session.started";
}

/**
 * Stream event emitted when one runtime turn starts.
 */
export interface TurnStartedStreamEvent {
  data: {
    sequence: number;
    turnId: string;
  };
  type: "turn.started";
}

/**
 * Stream event emitted when the runtime receives one normalized user message.
 */
export interface MessageReceivedStreamEvent {
  data: {
    message: string;
    sequence: number;
    turnId: string;
  };
  type: "message.received";
}

/**
 * Stream event emitted when the harness requests one stable runtime action
 * batch.
 *
 * `data.actions.length === 1` is the serial case. `data.actions.length > 1`
 * is the parallel case for that assistant batch.
 */
export interface ActionsRequestedStreamEvent {
  data: {
    actions: readonly RuntimeActionRequest[];
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "actions.requested";
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
    turnId: string;
  };
  type: "input.requested";
}

/**
 * Stream event emitted for each runtime action result projected back into the
 * session loop.
 */
export interface ActionResultStreamEvent {
  data: {
    error?: ActionResultError;
    result: RuntimeActionResult;
    sequence: number;
    stepIndex: number;
    status: ActionResultStatus;
    turnId: string;
  };
  type: "action.result";
}

/**
 * Stream event emitted when the parent workflow starts a child subagent session.
 */
export interface SubagentCalledStreamEvent {
  data: {
    callId: string;
    childSessionId: string;
    sessionId: string;
    sequence: number;
    name: string;
    remote?: {
      url: string;
    };
    toolName: string;
    turnId: string;
    workflowId: string;
  };
  type: "subagent.called";
}

/**
 * Stream event emitted when an inline subagent execution starts.
 */
export interface SubagentStartedStreamEvent {
  data: {
    callId: string;
    subagentName: string;
  };
  type: "subagent.started";
}

/**
 * Stream event (`type: "subagent.event"`) wrapping one child stream event
 * produced by an inline subagent, under `data.event`, tagged with the
 * originating `data.callId` and `data.subagentName`.
 */
export interface SubagentChildEventStreamEvent {
  data: {
    callId: string;
    event: HandleMessageStreamEvent;
    subagentName: string;
  };
  type: "subagent.event";
}

/**
 * Stream event emitted when an inline subagent completes.
 */
export interface SubagentCompletedStreamEvent {
  data: {
    callId: string;
    output: string;
    subagentName: string;
  };
  type: "subagent.completed";
}

/**
 * Stream event emitted when one assistant text delta is appended to the
 * current message for the current step.
 */
export interface MessageAppendedStreamEvent {
  data: {
    messageDelta: string;
    messageSoFar: string;
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
  type: "message.appended";
}

/**
 * Stream event emitted when one reasoning delta is appended to the current
 * reasoning block for the current step.
 */
export interface ReasoningAppendedStreamEvent {
  data: {
    reasoningDelta: string;
    reasoningSoFar: string;
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
    sequence: number;
    stepIndex: number;
    turnId: string;
    usage?: {
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
 * Stream event emitted when a connection needs user authorization before
 * its tools can be used.
 */
export interface AuthorizationRequiredStreamEvent {
  data: {
    authorization?: ConnectionAuthorizationChallenge;
    description: string;
    name: string;
    sequence: number;
    stepIndex: number;
    turnId: string;
    webhookUrl?: string;
  };
  type: "authorization.required";
}

/**
 * Outcome of one completed authorization attempt, emitted on
 * {@link AuthorizationCompletedStreamEvent}.
 */
export type ConnectionAuthorizationOutcome = "authorized" | "declined" | "failed" | "timed-out";

/**
 * Stream event emitted once `completeAuthorization` has resolved
 * (successfully or otherwise) for one pending connection. Carries a
 * stable `outcome` plus an optional human-readable `reason`.
 *
 * Emitted when the tool completes authorization on resume, before the
 * model's next fragment streams in.
 */
export interface AuthorizationCompletedStreamEvent {
  data: {
    /**
     * The challenge from the matching `authorization.required` event,
     * journaled across the park. Lets channels keep rendering the
     * challenge's `displayName` in completion status text.
     */
    authorization?: ConnectionAuthorizationChallenge;
    name: string;
    outcome: ConnectionAuthorizationOutcome;
    reason?: string;
    sequence: number;
    stepIndex: number;
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
 * Serializable stream event union for the durable message session flow.
 */
export type HandleMessageStreamEvent = (
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
  | SubagentCalledStreamEvent
  | SubagentChildEventStreamEvent
  | SubagentCompletedStreamEvent
  | SubagentStartedStreamEvent
  | ActionsRequestedStreamEvent
  | InputRequestedStreamEvent
  | ActionResultStreamEvent
  | ReasoningCompletedStreamEvent
  | StepCompletedStreamEvent
  | StepFailedStreamEvent
  | StepStartedStreamEvent
  | TurnCompletedStreamEvent
  | TurnFailedStreamEvent
  | TurnStartedStreamEvent
) & {
  readonly meta?: HandleMessageStreamEventMeta;
};

/**
 * Stream events that represent an unrecovered turn/session failure.
 */
export type TurnFailureStreamEvent =
  | SessionFailedStreamEvent
  | StepFailedStreamEvent
  | TurnFailedStreamEvent;

/**
 * One public session stream event after runtime metadata has been stamped.
 *
 * Runtime/execution code owns this stamping boundary. Replays must preserve the
 * original `meta.at` value instead of recomputing it.
 */
export type TimedHandleMessageStreamEvent = HandleMessageStreamEvent & {
  readonly meta: HandleMessageStreamEventMeta;
};

const textEncoder = new TextEncoder();

/**
 * Returns true when the current stream has reached a turn boundary or terminal
 * session outcome.
 */
export function isCurrentTurnBoundaryEvent(event: HandleMessageStreamEvent): boolean {
  return (
    event.type === "session.completed" ||
    event.type === "session.failed" ||
    event.type === "session.waiting"
  );
}

/**
 * Narrows a stream event to the failure events that terminate or poison a turn.
 */
export function isTurnFailureEvent(
  event: HandleMessageStreamEvent,
): event is TurnFailureStreamEvent {
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
}): SessionStartedStreamEvent {
  const data: SessionStartedStreamEvent["data"] = {};

  if (input?.invocation !== undefined) {
    data.invocation = input.invocation;
  }

  if (input?.runtime !== undefined) {
    data.runtime = input.runtime;
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
  readonly turnId: string;
}): TurnStartedStreamEvent {
  return {
    data: {
      sequence: input.sequence,
      turnId: input.turnId,
    },
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
  readonly turnId: string;
}): MessageReceivedStreamEvent {
  return {
    data: {
      message: summarizeUserContent(input.message),
      sequence: input.sequence,
      turnId: input.turnId,
    },
    type: "message.received",
  };
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

/**
 * Creates the `actions.requested` event for one stable execution batch.
 */
export function createActionsRequestedEvent(input: {
  readonly actions: readonly RuntimeActionRequest[];
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): ActionsRequestedStreamEvent {
  return {
    data: {
      actions: input.actions,
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      turnId: input.turnId,
    },
    type: "actions.requested",
  };
}

/**
 * Creates the `authorization.required` event for one connection
 * that needs user authorization before its tools can be used.
 *
 * `authorization` and `webhookUrl` are present together when the runtime
 * has suspended the turn on a framework-owned webhook; both are absent
 * for `getToken`-only connections that authorize out of band.
 */
export function createAuthorizationRequiredEvent(input: {
  readonly authorization?: ConnectionAuthorizationChallenge;
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
  if (input.authorization !== undefined) {
    data.authorization = input.authorization;
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
 * connection after `completeAuthorization` has resolved or the
 * authorization deadline has expired.
 */
export function createAuthorizationCompletedEvent(input: {
  readonly authorization?: ConnectionAuthorizationChallenge;
  readonly name: string;
  readonly outcome: ConnectionAuthorizationOutcome;
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
  if (input.authorization !== undefined) {
    data.authorization = input.authorization;
  }
  if (input.reason !== undefined) {
    data.reason = input.reason;
  }
  return {
    data,
    type: "authorization.completed",
  };
}

/**
 * Creates the `input.requested` event for one pending HITL batch.
 */
export function createInputRequestedEvent(input: {
  readonly requests: readonly InputRequest[];
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): InputRequestedStreamEvent {
  return {
    data: {
      requests: input.requests,
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      turnId: input.turnId,
    },
    type: "input.requested",
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
      result: input.result,
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      status: outcome.status,
      turnId: input.turnId,
    },
    type: "action.result",
  };
}

/**
 * Creates the `subagent.called` event for one started child workflow session.
 */
export function createSubagentCalledEvent(input: {
  readonly callId: string;
  readonly childSessionId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly name: string;
  readonly remote?: {
    readonly url: string;
  };
  readonly toolName: string;
  readonly turnId: string;
  readonly workflowId: string;
}): SubagentCalledStreamEvent {
  return {
    data: {
      callId: input.callId,
      childSessionId: input.childSessionId,
      sessionId: input.sessionId,
      sequence: input.sequence,
      name: input.name,
      remote: input.remote,
      toolName: input.toolName,
      turnId: input.turnId,
      workflowId: input.workflowId,
    },
    type: "subagent.called",
  };
}

/**
 * Creates the `message.appended` event for one streamed assistant text delta.
 */
export function createMessageAppendedEvent(input: {
  readonly messageDelta: string;
  readonly messageSoFar: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): MessageAppendedStreamEvent {
  return {
    data: {
      messageDelta: input.messageDelta,
      messageSoFar: input.messageSoFar,
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
  readonly reasoningSoFar: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): ReasoningAppendedStreamEvent {
  return {
    data: {
      reasoningDelta: input.reasoningDelta,
      reasoningSoFar: input.reasoningSoFar,
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
  readonly message: string | null;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): MessageCompletedStreamEvent {
  return {
    data: {
      finishReason: input.finishReason ?? "stop",
      message: input.message,
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      turnId: input.turnId,
    },
    type: "message.completed",
  };
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
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): StepStartedStreamEvent {
  return {
    data: {
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
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
  readonly usage?: {
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
 * Creates the `turn.completed` event for one terminal successful turn.
 */
export function createTurnCompletedEvent(input: {
  readonly sequence: number;
  readonly turnId: string;
}): TurnCompletedStreamEvent {
  return {
    data: {
      sequence: input.sequence,
      turnId: input.turnId,
    },
    type: "turn.completed",
  };
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
export function createSessionWaitingEvent(): SessionWaitingStreamEvent {
  return {
    data: {
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
 * Stamps one session event with durable timing metadata immediately before it
 * is written to the workflow-owned stream.
 *
 * Only runtime/execution code should call this. Keeping one stamping seam
 * ensures every persisted event shares the same clock contract and replay never
 * invents new timestamps.
 */
export function timestampHandleMessageStreamEvent(
  event: HandleMessageStreamEvent,
  at = new Date().toISOString(),
): TimedHandleMessageStreamEvent {
  return {
    ...event,
    meta: {
      at,
    },
  };
}

/**
 * Encodes one message stream event as newline-delimited JSON.
 */
export function encodeMessageStreamEvent(event: TimedHandleMessageStreamEvent): Uint8Array {
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
