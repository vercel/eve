import type {
  ConnectionAuthDefinition,
  HeadersDefinition,
  ToolFilterDefinition,
} from "#runtime/connections/types.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { JsonValue } from "#public/types/json.js";
import { normalizeAuthorizationSpec } from "#runtime/connections/validate-authorization.js";
import { stampConnectionProtocol } from "#public/definitions/connections/protocol.js";
import type { Approval } from "#public/definitions/approval.js";
import { stampDefinitionKey } from "#public/tool-result-narrowing.js";

/** Context available while resolving an application-provided MCP tool argument. */
export type ProvidedArgumentContext = SessionContext & {
  /** Bare tool name published by the remote MCP server. */
  readonly toolName: string;
};

/** A static or per-call value for one application-provided MCP tool argument. */
export type ProvidedArgumentValue =
  | JsonValue
  | Promise<JsonValue>
  | ((ctx: ProvidedArgumentContext) => JsonValue | Promise<JsonValue>);

/**
 * MCP tool argument values supplied by the application instead of the model.
 *
 * Configured keys are removed from remote input schemas before the schemas are
 * exposed to the model, then resolved and added to every outgoing tool call.
 */
export type ProvidedArgumentsDefinition = Readonly<Record<string, ProvidedArgumentValue>>;

/** Per-call behavior for tools exposed by an MCP connection. */
export interface McpToolCallDefinition {
  /** Application-owned arguments hidden from the model and added at execution time. */
  readonly providedArguments?: ProvidedArgumentsDefinition;
}

/**
 * Public definition for an MCP client connection authored in
 * `connections/*.ts`.
 *
 * The connection's runtime name is derived from its filename (the
 * slug under `agent/connections/`, without the extension). A
 * connection authored at `agent/connections/linear.ts` is registered
 * as `"linear"`.
 *
 * Both `auth` and `headers` are optional. Omit both for
 * servers that require no authentication (e.g. localhost).
 */
export interface McpClientConnectionDefinition {
  /**
   * The MCP server's HTTP endpoint URL.
   *
   * Must support Streamable HTTP or SSE transport.
   */
  readonly url: string;
  /**
   * Human-readable summary of the connection and its tools.
   *
   * The system prompt layer uses it to describe the connection to
   * the model, and `connection_search` results use it so the model
   * can choose which connection to query.
   */
  readonly description: string;
  /**
   * Auth strategy for the MCP server. The runtime sends the
   * resolved token as `Authorization: Bearer <token>`.
   *
   * - `getToken`-only: covers static API keys, pre-provisioned
   *   JWTs, and out-of-band OAuth. Defaults to
   *   `principalType: "app"` when omitted.
   * - Three-method form: provide `startAuthorization` and
   *   `completeAuthorization` together to opt into
   *   interactive OAuth authorization.
   * - Resolver form: pass `(ctx) => provider` to select either shape
   *   from the active caller's session context.
   *
   * Optional when `headers` is provided for non-Bearer auth schemes.
   */
  auth?: ConnectionAuthDefinition;
  /**
   * Optional per-connection approval gate for connection tool calls.
   *
   * Use the helpers from `eve/tools/approval`:
   * - `never()`: allow all tool calls without approval
   * - `once()`: require approval only the first time per session
   * - `always()`: require approval for every tool call
   *
   * When omitted, tool calls execute without approval, consistent
   * with authored tools.
   */
  approval?: Approval;
  /**
   * Arbitrary HTTP headers sent with every request to the MCP server.
   *
   * Use for non-Bearer auth (e.g. API key headers) or server-level
   * configuration headers. Can be combined with `auth`. The whole map
   * or individual values may be callbacks that receive the active
   * session context.
   */
  headers?: HeadersDefinition;
  /**
   * Per-call behavior for tools exposed by this MCP connection.
   *
   * Use `providedArguments` for application-owned values such as UCP's
   * `arguments.meta`. eve removes configured keys from the model-facing input
   * schema and adds their resolved values immediately before execution.
   */
  toolCall?: McpToolCallDefinition;
  /**
   * Client-side tool filter. When set, the model sees only tools
   * whose names pass the filter; `connection_search` drops all
   * others.
   *
   * Specify exactly one of `allow` or `block`.
   */
  tools?: ToolFilterDefinition;
}

/**
 * Defines an MCP client connection.
 *
 * Validates static auth providers at definition time, in particular the
 * "both-or-neither" constraint for `startAuthorization` and
 * `completeAuthorization`. Context-aware auth resolvers are validated when
 * eve invokes them inside an active turn.
 */
export function defineMcpClientConnection(
  definition: McpClientConnectionDefinition,
): McpClientConnectionDefinition {
  if (definition.auth !== undefined && typeof definition.auth !== "function") {
    definition.auth = normalizeAuthorizationSpec(definition.auth, "defineMcpClientConnection:");
  }
  stampDefinitionKey(definition, `connection:${definition.url}`);
  stampConnectionProtocol(definition, "mcp");
  return definition;
}
