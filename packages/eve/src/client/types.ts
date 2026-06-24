import type { UserContent } from "ai";
import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import type { HandleMessageStreamEvent } from "#protocol/message.js";
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
   * Base URL of the eve agent server.
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

  /**
   * Maximum number of stream reconnection attempts per message turn.
   *
   * @default 3
   */
  readonly maxReconnectAttempts?: number;

  /**
   * Keep a session's continuation token after a normal `session.completed`
   * boundary.
   *
   * By default, completed turns reset the client-side session so the next
   * `send()` starts a fresh server-side conversation. Interactive clients can
   * set this to preserve durable session state, including framework-managed
   * sandbox state, across follow-up prompts until they explicitly create a new
   * session.
   *
   * @default false
   */
  readonly preserveCompletedSessions?: boolean;
}

/**
 * Input payload for {@link ClientSession.send}. Pass a string as shorthand for
 * `{ message: string }`, or pass an object to include a message, HITL input
 * responses, one-turn client context, structured-output schema, abort signal,
 * and per-turn headers.
 */
export type SendTurnInput<TOutput = unknown> = string | SendTurnPayload<TOutput>;

/**
 * Object form accepted by {@link ClientSession.send}.
 */
export interface SendTurnPayload<TOutput = unknown> {
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
   * HITL responses resolving pending approvals or questions.
   */
  readonly inputResponses?: readonly InputResponse[];

  /**
   * Optional follow-up user message for the same turn.
   */
  readonly message?: string | UserContent;

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
   * Abort signal for cancelling the request.
   */
  readonly signal?: AbortSignal;

  /**
   * Additional headers for this request only.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Options for {@link ClientSession.stream}.
 */
export interface StreamOptions {
  /**
   * Number of events already consumed. The server will skip events before
   * this index.
   */
  readonly startIndex?: number;

  /**
   * Abort signal for cancelling the stream.
   */
  readonly signal?: AbortSignal;
}

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
  readonly events: HandleMessageStreamEvent[];

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
 * Serializable session cursor. Persist this value and pass it back to
 * {@link Client.session} to resume a conversation later.
 */
export interface SessionState {
  readonly continuationToken?: string;
  readonly sessionId?: string;
  readonly streamIndex: number;
}
