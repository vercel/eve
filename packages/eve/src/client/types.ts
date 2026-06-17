import type { UserContent } from "ai";
import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { JsonObject } from "#shared/json.js";
import type { ModelRouting } from "#shared/agent-definition.js";
import type { ModelEndpointStatus } from "#shared/model-endpoint-status.js";

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
  | { readonly bearer: TokenValue };

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
 * Source reference shared by entries in {@link AgentInfoResult}.
 */
export interface AgentInfoSource {
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly sourceId?: string;
  readonly sourceKind: string;
}

export interface AgentInfoEntry extends AgentInfoSource {
  readonly name: string;
}

export interface AgentInfoToolEntry extends AgentInfoEntry {
  readonly description: string;
  readonly hasAuth: boolean;
  readonly hasExecute: boolean;
  readonly hasModelOutputProjection: boolean;
  readonly hasOutputSchema: boolean;
  readonly inputSchema: unknown;
  readonly origin: "authored" | "framework";
  readonly outputSchema: unknown;
  readonly replacesFrameworkTool: boolean;
  readonly requiresApproval: boolean;
}

export interface AgentInfoFrameworkToolEntry extends AgentInfoToolEntry {
  readonly disabledByAuthor: boolean;
  readonly replacedByAuthoredTool: boolean;
  readonly status: "active" | "disabled" | "replaced";
}

export interface AgentInfoDynamicResolverEntry extends AgentInfoSource {
  readonly eventNames: readonly string[];
  readonly origin: "authored" | "framework";
  readonly slug: string;
}

export interface AgentInfoTools {
  readonly authored: readonly AgentInfoToolEntry[];
  readonly available: readonly AgentInfoToolEntry[];
  readonly disabledFramework: readonly string[];
  readonly dynamic: readonly AgentInfoDynamicResolverEntry[];
  readonly framework: readonly AgentInfoFrameworkToolEntry[];
  readonly reserved: readonly string[];
}

export interface AgentInfoSkillEntry extends AgentInfoEntry {
  readonly description: string;
  readonly license?: string;
  readonly markdown: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface AgentInfoInstructionsEntry extends AgentInfoEntry {
  readonly markdown: string;
}

export interface AgentInfoInstructions {
  readonly dynamic: readonly AgentInfoDynamicResolverEntry[];
  readonly static: AgentInfoInstructionsEntry | null;
}

export interface AgentInfoScheduleEntry extends AgentInfoEntry {
  readonly cron: string;
  readonly hasRun: boolean;
  readonly markdown?: string;
}

export interface AgentInfoSubagentEntry extends AgentInfoEntry {
  readonly description: string;
  readonly entryPath: string;
  readonly nodeId: string;
  readonly rootPath: string;
  readonly summary: {
    readonly channels: number;
    readonly connections: number;
    readonly hooks: number;
    readonly instructions: boolean;
    readonly schedules: number;
    readonly skills: number;
    readonly tools: number;
  };
}

export interface AgentInfoChannelEntry extends AgentInfoEntry {
  readonly adapterKind?: string;
  readonly method: string;
  readonly origin: "authored" | "framework";
  readonly urlPath: string;
}

export interface AgentInfoFrameworkChannelEntry extends AgentInfoChannelEntry {
  readonly disabledByAuthor: boolean;
  readonly replacedByAuthoredChannel: boolean;
  readonly status: "active" | "disabled" | "replaced";
}

export interface AgentInfoChannels {
  readonly authored: readonly AgentInfoChannelEntry[];
  readonly available: readonly AgentInfoChannelEntry[];
  readonly disabledFramework: readonly string[];
  readonly framework: readonly AgentInfoFrameworkChannelEntry[];
}

export interface AgentInfoConnectionEntry extends AgentInfoSource {
  readonly connectionName: string;
  readonly description: string;
  readonly hasApproval: boolean;
  readonly hasAuthorization: boolean;
  readonly hasHeaders: boolean;
  readonly protocol: string;
  readonly toolFilter?: unknown;
  readonly url: string;
}

export interface AgentInfoHookEntry extends AgentInfoSource {
  readonly eventNames: readonly string[];
  readonly slug: string;
}

export interface AgentInfoSandboxEntry extends AgentInfoSource {
  readonly backendKind?: string;
  readonly description?: string;
  readonly hasBootstrap: boolean;
  readonly hasOnSession: boolean;
  readonly revalidationKey?: string;
  readonly sourceHash?: string;
}

export interface AgentInfoResult {
  readonly agent: {
    readonly agentRoot: string;
    readonly appRoot: string;
    readonly configSource?: AgentInfoSource;
    readonly description?: string;
    readonly model: {
      readonly contextWindowTokens?: number;
      readonly id: string;
      readonly providerOptions?: unknown;
      readonly source?: AgentInfoSource;
      /** How the model is routed (gateway vs external), decided at compile time. */
      readonly routing?: ModelRouting;
      /** Composed routing + runtime credential readiness; absent only on legacy payloads. */
      readonly endpoint?: ModelEndpointStatus;
    };
    readonly name: string;
    readonly outputSchema?: unknown;
  };
  readonly capabilities: {
    readonly devRoutes: boolean;
  };
  readonly channels: AgentInfoChannels;
  readonly connections: readonly AgentInfoConnectionEntry[];
  readonly diagnostics: {
    readonly discoveryErrors: number;
    readonly discoveryWarnings: number;
  };
  readonly hooks: readonly AgentInfoHookEntry[];
  readonly instructions: AgentInfoInstructions;
  readonly kind: "eve-agent-info";
  readonly mode: "development" | "production";
  readonly sandbox: AgentInfoSandboxEntry | null;
  readonly schedules: readonly AgentInfoScheduleEntry[];
  readonly skills: {
    readonly dynamic: readonly AgentInfoDynamicResolverEntry[];
    readonly static: readonly AgentInfoSkillEntry[];
  };
  readonly subagents: {
    readonly local: readonly AgentInfoSubagentEntry[];
    readonly total: number;
  };
  readonly tools: AgentInfoTools;
  readonly version: 1;
  readonly workflow: {
    readonly enabled: boolean;
    readonly toolName: string;
  };
  readonly workspace: {
    readonly resourceRoot: unknown;
    readonly rootEntries: readonly string[];
  };
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
