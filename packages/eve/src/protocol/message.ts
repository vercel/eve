import type { MessageContent } from "#shared/message-content.js";

import type { Answer } from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";

export const EVE_SESSION_ID_HEADER = "x-eve-session-id";
export const EVE_STREAM_FORMAT_HEADER = "x-eve-stream-format";
export const EVE_STREAM_TAIL_INDEX_HEADER = "x-eve-stream-tail-index";
export const EVE_STREAM_VERSION_HEADER = "x-eve-stream-version";
export const EVE_MESSAGE_STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
export const EVE_MESSAGE_STREAM_FORMAT = "ndjson";
export const EVE_MESSAGE_STREAM_VERSION = "27";

/**
 * The session this one replaced. Present on a session eve started in place of
 * one whose deployment was retired, when the next ordinary channel message
 * arrived before the earlier session timed out. This session has its own id,
 * stream, auth, and state, and starts with no history from its predecessor;
 * read the predecessor with `sessions.attach(sessionId)` from `eve/server`.
 */
export interface SessionPredecessor {
  /** Id of the session this one replaced. Its recorded history stays readable. */
  readonly sessionId: string;
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
 * `message` is either a plain text string or an array of message parts (`text`
 * and `file`); a file's `data` is a string: base64, a `data:` URL, or a URL.
 * `clientContext` is turn-scoped client/page context; the channel converts it
 * into internal model context for every model call in that turn.
 */
export type HandleMessageRequestBody =
  | {
      readonly answers?: never;
      readonly message: MessageContent;
      readonly clientContext?: string | readonly string[] | JsonObject;
      readonly outputSchema?: JsonObject;
    }
  | {
      readonly answers: readonly Answer[];
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

/**
 * Why the session cancelled a task call: the model called `eve__task_cancel`,
 * someone cancelled the turn (or, between turns, the tasks still working), or
 * the turn ended while the task still worked.
 */
export type TaskCancelReason = "task_cancel" | "turn_cancelled" | "turn_ended";
