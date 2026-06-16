/**
 * Connection authoring helpers for `agent/connections/*.ts` files.
 */

export type {
  AuthorizationCallback,
  AuthorizationDefinition,
  ConnectionAuthDefinition,
  ConnectionPrincipal,
  HeadersDefinition,
  InteractiveAuthorizationDefinition,
  NonInteractiveAuthorizationDefinition,
  TokenResult,
  ToolFilterDefinition,
} from "#runtime/connections/types.js";
export { defineInteractiveAuthorization } from "#runtime/connections/types.js";
export type { JsonValue } from "#public/types/json.js";
export {
  defineMcpClientConnection,
  type McpClientConnectionDefinition,
} from "#public/definitions/connections/mcp.js";
export {
  defineOpenAPIConnection,
  type OpenAPIConnectionDefinition,
  type OpenAPISpecSource,
} from "#public/definitions/connections/openapi.js";
export {
  type ConnectionAuthorizationChallenge,
  ConnectionAuthorizationFailedError,
  type ConnectionAuthorizationFailedErrorOptions,
  ConnectionAuthorizationRequiredError,
  type ConnectionAuthorizationRequiredErrorOptions,
  isConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "#public/connections/errors.js";
