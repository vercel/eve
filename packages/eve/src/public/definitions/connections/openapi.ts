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
 * The OpenAPI document backing the connection: either an HTTPS URL the
 * runtime fetches on first use, or an already-parsed OpenAPI 3.x /
 * Swagger 2.0 object.
 */
export type OpenAPISpecSource = string | Record<string, unknown>;

/**
 * Public definition for an OpenAPI connection authored in
 * `connections/*.ts`.
 *
 * The connection's runtime name is derived from its filename (the slug
 * under `agent/connections/`, without the extension). A connection
 * authored at `agent/connections/vercel.ts` is registered as
 * `"vercel"`.
 *
 * Each operation in the document becomes a connection tool the model can
 * discover via `connection_search` and call by its qualified name (e.g.
 * `vercel__getProjects`). The tool name is the operation's
 * `operationId`; operations without one get a deterministic synthesized
 * name (`<method>_<sanitized-path>`).
 *
 * Both `auth` and `headers` are optional. Omit both for public APIs
 * that require no authentication.
 */
export interface OpenAPIConnectionDefinition {
  /**
   * The OpenAPI 3.x or Swagger 2.0 document. Pass an HTTPS URL to fetch
   * and parse at runtime, or an inline parsed object.
   */
  readonly spec: OpenAPISpecSource;
  /**
   * Base URL the runtime resolves operation paths against (e.g.
   * `https://api.example.com`).
   *
   * Optional: when omitted, the runtime uses the document's first usable
   * `servers` entry (OpenAPI 3.x) or `schemes`/`host`/`basePath`
   * (Swagger 2.0). It fills server-variable `{var}` placeholders from
   * each variable's `default`, and resolves a relative server URL
   * against the spec's URL. Provide `baseUrl` when the document has no
   * derivable base URL, or to override it.
   */
  readonly baseUrl?: string;
  /**
   * Human-readable summary of the connection and its operations.
   *
   * The system prompt layer uses it to describe the connection to the
   * model, and `connection_search` results use it so the model can
   * choose which connection to query.
   */
  readonly description: string;
  /**
   * Auth strategy for the API. The runtime sends the resolved token as
   * `Authorization: Bearer <token>`.
   *
   * - `getToken`-only: covers static API keys, pre-provisioned tokens,
   *   and out-of-band OAuth. Defaults to `principalType: "app"` when
   *   omitted.
   * - Three-method form: provide `startAuthorization` and
   *   `completeAuthorization` together to opt into interactive OAuth.
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
   */
  approval?: Approval;
  /**
   * Arbitrary HTTP headers sent with every request to the API.
   *
   * Use for non-Bearer auth (e.g. API key headers) or configuration
   * headers. Can be combined with `auth`. The whole map or individual
   * values may be callbacks that receive the active session context.
   */
  headers?: HeadersDefinition;
  /**
   * Operation filter keyed on `operationId`. When set, the model sees
   * only operations whose id passes the filter; `connection_search`
   * drops all others.
   *
   * Specify exactly one of `allow` or `block`. Mirrors `tools` on MCP
   * connections, but names operations rather than tools.
   */
  operations?: ToolFilterDefinition;
}

/**
 * Defines an OpenAPI connection.
 *
 * Validates static auth providers at definition time, in particular the
 * "both-or-neither" constraint for `startAuthorization` and
 * `completeAuthorization`. Context-aware auth resolvers are validated when
 * eve invokes them inside an active turn.
 */
export function defineOpenAPIConnection(
  definition: OpenAPIConnectionDefinition,
): OpenAPIConnectionDefinition {
  if (definition.auth !== undefined && typeof definition.auth !== "function") {
    definition.auth = normalizeAuthorizationSpec(definition.auth, "defineOpenAPIConnection:");
  }
  const definitionKey =
    definition.baseUrl ??
    (typeof definition.spec === "string" ? definition.spec : definition.description);
  stampDefinitionKey(definition, `connection:${definitionKey}`);
  stampConnectionProtocol(definition, "openapi");
  return definition;
}
