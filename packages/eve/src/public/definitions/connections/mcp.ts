import type {
  ConnectionAuthDefinition,
  HeadersDefinition,
  ToolFilterDefinition,
} from "#runtime/connections/types.js";
import { normalizeAuthorizationSpec } from "#runtime/connections/validate-authorization.js";
import { stampConnectionProtocol } from "#public/definitions/connections/protocol.js";
import type { NeedsApprovalContext } from "#public/definitions/tool.js";
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
  approval?: (ctx: NeedsApprovalContext) => boolean;
  /**
   * Arbitrary HTTP headers sent with every request to the MCP server.
   *
   * Use for non-Bearer auth (e.g. API key headers) or server-level
   * configuration headers. Can be combined with `auth`.
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
 * Validates the {@link ConnectionAuthDefinition} shape at
 * definition time, in particular the "both-or-neither" constraint
 * for `startAuthorization` and `completeAuthorization`: providing
 * exactly one is a definition error. `getToken` alone is valid and
 * selects the non-interactive flow; providing both opts into
 * interactive OAuth authorization.
 */
export function defineMcpClientConnection(
  definition: McpClientConnectionDefinition,
): McpClientConnectionDefinition {
  if (definition.auth !== undefined) {
    definition.auth = normalizeAuthorizationSpec(definition.auth, "defineMcpClientConnection:");
  }
  stampDefinitionKey(definition, `connection:${definition.url}`);
  stampConnectionProtocol(definition, "mcp");
  return definition;
}
