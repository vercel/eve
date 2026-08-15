import type { UserContent } from "ai";
import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import type { MessageStreamEvent } from "#protocol/message.js";
import type { CancelTurnResult } from "#protocol/cancel-turn.js";
import type { ClearStatus } from "#protocol/clear-session.js";
import type { CompactStatus } from "#protocol/compact-session.js";
import type { ResetStatus } from "#protocol/reset-session.js";
import type { TurnPolicy } from "#channel/types.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { JsonObject } from "#shared/json.js";

export type {
  AgentInfoChannelEntry,
  AgentInfoChannels,
  AgentInfoConnectionEntry,
  AgentInfoDynamicResolverEntry,
  AgentInfoEntry,
  AgentInfoFrameworkChannelEntry,
  AgentInfoFrameworkToolEntry,
  AgentInfoHookEntry,
  AgentInfoInstructions,
  AgentInfoInstructionsEntry,
  AgentInfoResult,
  AgentInfoSandboxEntry,
  AgentInfoScheduleEntry,
  AgentInfoSkillEntry,
  AgentInfoSource,
  AgentInfoSubagentEntry,
  AgentInfoToolEntry,
  AgentInfoTools,
} from "./agent-info-schema.js";

/**
 * Static credential value or per-request credential resolver.
 */
export type TokenValue = string | (() => string | Promise<string>);

/**
 * Static custom-headers map or per-request resolver.
 *
 * When a function is provided, it is invoked before every HTTP call so
 * callers can return short-lived values (e.g. refreshed bypass tokens)
 * without rebuilding the client.
 */
export type HeadersValue =
  | Readonly<Record<string, string>>
  | (() => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>);

/**
 * Authentication configuration for the client.
 */
export type ClientAuth =
  | { readonly basic: { readonly username: string; readonly password: TokenValue } }
  | { readonly bearer: TokenValue }
  // The client-side mirror of the framework's server `vercelOidc()` channel
  // auth: one token the client expands into both Vercel deployment-protection
  // headers (Authorization and {@link VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER}).
  | { readonly vercelOidc: { readonly token: TokenValue } };

/**
 * Vercel header that presents a trusted OIDC token as proof the caller is
 * authorized for a protected deployment. The client emits it alongside
 * `Authorization` for the {@link ClientAuth} `vercelOidc` variant.
 */
export const VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER = "x-vercel-trusted-oidc-idp-token";

/** Redirect modes supported by the configured fetch implementation. */
export type ClientRedirectPolicy = NonNullable<RequestInit["redirect"]>;

/**
 * Configuration for creating a new {@link Client}.
 */
export interface ClientOptions {
  /**
   * Base URL of the eve agent server. Query parameters are included on every
   * request; request-specific parameters override parameters with the same name.
   */
  readonly host: string;

  /**
   * Authentication configuration. The client resolves credentials before each
   * request, so token-refresh callbacks are called on every HTTP call.
   */
  readonly auth?: ClientAuth;

  /**
   * Custom headers sent with every request. Pass a function to resolve
   * the headers fresh for each request (useful for short-lived tokens
   * that need to be refreshed alongside the bearer credential).
   */
  readonly headers?: HeadersValue;

  /**
   * Redirect policy for every request, including streams. Overrides a
   * per-request `RequestInit.redirect`. Credential-bearing clients should use
   * `"manual"` or `"error"` so custom auth headers can't follow a cross-origin
   * redirect.
   */
  readonly redirect?: ClientRedirectPolicy;
}

/**
 * Input object for creating a client session. The first message is required.
 */
export interface SendTurnInput<TOutput = unknown> extends SendTurnOptions<TOutput> {
  readonly message: string | UserContent;
}

/** Options shared by message sends and HITL responses on a client session. */
export interface SendTurnOptions<TOutput = unknown> {
  /** Policy for a message sent while the fixed session has an active turn. */
  readonly turnPolicy?: TurnPolicy;

  /**
   * Ephemeral client/page context for the next model call only.
   *
   * Strings are rendered as user-role model context messages. Objects are
   * JSON-serialized into one user-role model context message. Client context
   * rides along with a message or HITL response; it does not dispatch a turn by
   * itself and is never persisted to durable session history.
   */
  readonly clientContext?: string | readonly string[] | JsonObject;

  /**
   * Optional schema the harness must satisfy before this turn terminates.
   *
   * The client lowers Standard Schema implementations (Zod, Valibot,
   * ArkType, etc.) to JSON Schema before sending the request. The server is
   * authoritative for validation; {@link MessageResult.data} is typed to this
   * schema's output type and is not revalidated client-side.
   */
  readonly outputSchema?: StandardJSONSchemaV1<unknown, TOutput> | JsonObject;

  /**
   * Reconnection policy for the response event stream. Omit to use the default
   * policy, or pass `{ reconnect: false }` when the caller owns cursor recovery.
   */
  readonly streamReconnectPolicy?: StreamReconnectPolicy;

  /**
   * Abort signal for cancelling the request.
   */
  readonly signal?: AbortSignal;

  /**
   * Additional headers for this request only. These override same-name
   * client-level headers, including headers generated by `ClientOptions.auth`.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Options for answering pending HITL input requests on a client session. */
export type RespondTurnOptions<TOutput = unknown> = SendTurnOptions<TOutput>;

/** @internal Transport envelope used by stores and command adapters. */
export type SendTurnPayload<TOutput = unknown> =
  | (SendTurnOptions<TOutput> & {
      readonly inputResponses?: never;
      readonly message: string | UserContent;
    })
  | (RespondTurnOptions<TOutput> & {
      readonly inputResponses: readonly InputResponse[];
      readonly message?: never;
    });

/** Retry and backoff settings for one kind of stream reconnection. */
export interface StreamReconnectRetryPolicy {
  /** Initial delay before retrying, in milliseconds. */
  readonly baseDelayMs?: number;

  /** Maximum number of attempts governed by this retry policy. */
  readonly maxAttempts?: number;

  /** Maximum delay between retries, in milliseconds. */
  readonly maxDelayMs?: number;
}

/** Configurable policy used when automatic stream reconnection is enabled. */
export interface ResolvedStreamReconnectPolicy {
  /** Retry policy for opening an HTTP stream connection. */
  readonly streamOpenReconnectPolicy?: StreamReconnectRetryPolicy;

  /** Retry policy for reconnecting streams that make no progress. */
  readonly streamIdleReconnectPolicy?: StreamReconnectRetryPolicy;

  /** HTTP response statuses that may be retried while opening a stream. */
  readonly retryableErrorStatuses?: readonly number[];
}

/** Automatic stream reconnection configuration. */
export type StreamReconnectPolicy = ResolvedStreamReconnectPolicy | { readonly reconnect: false };

/**
 * Options for {@link ClientSession.stream}.
 */
export interface StreamOptions {
  /**
   * Reconnection policy for the event stream. Omit to use the default policy,
   * or pass `{ reconnect: false }` when the caller owns cursor recovery.
   */
  readonly streamReconnectPolicy?: StreamReconnectPolicy;

  /**
   * Absolute event index to start from. Negative values read relative to the
   * current tail (`-1` starts at the latest event). Relative-tail streams do
   * not reconnect automatically because their absolute cursor is unknown.
   */
  readonly startIndex?: number;

  /**
   * Follow the live stream after the durable tail (default). Pass `false`
   * for a bounded catch-up read: yields events until the cursor passes the
   * tail observed when the stream opened, then returns instead of
   * following. Requires a nonnegative start cursor.
   */
  readonly follow?: boolean;

  /**
   * Abort signal for cancelling the stream.
   */
  readonly signal?: AbortSignal;
}

/** Result of requesting cancellation for a client session's active turn. */
export type CancelSessionResult = CancelTurnResult;

/** Result of requesting a context clear for a client session. */
export type ClearResult =
  | {
      /** Session whose clear request was queued. */
      readonly sessionId: string;
      readonly status: Extract<ClearStatus, "accepted">;
    }
  | {
      /** The fixed session ID was unknown or no longer active. */
      readonly status: Extract<ClearStatus, "no_active_session">;
    };

/** Result of requesting context compaction for a client session. */
export type CompactResult =
  | {
      /** Session whose compaction request was queued. */
      readonly sessionId: string;
      readonly status: Extract<CompactStatus, "accepted">;
    }
  | {
      /** The fixed session ID was unknown or no longer active. */
      readonly status: Extract<CompactStatus, "no_active_session">;
    };

/** Result of terminally resetting a client session. */
export type ResetResult =
  | {
      /** The prior session was terminally retired. */
      readonly previousSessionId: string;
      readonly status: Extract<ResetStatus, "reset">;
    }
  | {
      /** The fixed session ID was unknown or no longer active. */
      readonly status: Extract<ResetStatus, "no_active_session">;
    };

/**
 * Aggregated result of one message turn, returned by
 * {@link MessageResponse.result}.
 */
export interface MessageResult<TOutput = unknown> {
  /**
   * Final structured result emitted by the harness, when this turn requested
   * an output schema and the server fulfilled it.
   */
  readonly data: TOutput | undefined;

  /**
   * The final completed assistant message text, or `undefined` if no terminal
   * `message.completed` event was observed.
   */
  readonly message: string | undefined;

  /**
   * All events received during this turn.
   */
  readonly events: MessageStreamEvent[];

  /**
   * HITL input requests emitted during this turn.
   */
  readonly inputRequests: readonly InputRequest[];

  /**
   * The session ID for this turn. Always populated; the post-turn handler
   * rejects responses that do not assign a session id.
   */
  readonly sessionId: string;

  /**
   * How the turn ended.
   *
   * - `"completed"`: the session finished (`session.completed`).
   * - `"waiting"`: the session is parked for the next user message
   *   (`session.waiting`).
   * - `"failed"`: the session ended in a terminal failure (`session.failed`).
   */
  readonly status: "completed" | "failed" | "waiting";
}

/**
 * Response from the health endpoint.
 */
export interface HealthResult {
  readonly ok: true;
  readonly status: "ready";
  readonly workflowId: string;
}

/**
 * Serializable cursor for one fixed, ID-addressed client session.
 */
export interface ClientSessionState {
  readonly sessionId: string;
  readonly streamIndex: number;
}

/**
 * Finite, cursor-consistent prefix of one durable session stream.
 */
export interface SessionSnapshot {
  /** Events from the start of the session through the durable tail observed when the read opened. */
  readonly events: readonly MessageStreamEvent[];

  /** Session cursor advanced exactly past {@link events}. */
  readonly session: ClientSessionState;
}
