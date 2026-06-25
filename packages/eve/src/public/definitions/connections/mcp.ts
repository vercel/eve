import type {
  ConnectionAuthDefinition,
  HeadersDefinition,
  ToolFilterDefinition,
} from "#runtime/connections/types.js";
import { normalizeAuthorizationSpec } from "#runtime/connections/validate-authorization.js";
import { stampConnectionProtocol } from "#public/definitions/connections/protocol.js";
import type { Approval } from "#public/definitions/approval.js";
import { stampDefinitionKey } from "#public/tool-result-narrowing.js";

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
