import type { UserContent } from "ai";

import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";

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
 * Stable failure payload projected onto `call.settled`.
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
 * Why the session cancelled a task call: the model called `eve__task_cancel`,
 * someone cancelled the turn (or, between turns, the tasks still working), or
 * the turn ended while the task still worked.
 */
export type TaskCancelReason = "task_cancel" | "turn_cancelled" | "turn_ended";

/**
 * Outcome of one completed authorization attempt, emitted on
 * {@link AuthorizationCompletedStreamEvent}.
 */
export type AuthorizationOutcome = "authorized" | "declined" | "failed" | "timed-out";

/**
 * @deprecated Use {@link AuthorizationOutcome}.
 */
export type ConnectionAuthorizationOutcome = AuthorizationOutcome;
