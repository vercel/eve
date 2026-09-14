import type {
  AuthorizationDefinition,
  ConnectionAuthorizationContext,
  NonInteractiveAuthorizationDefinition,
} from "#shared/connection-types.js";

/**
 * Authorization provider passed to the tool context's `getToken` or
 * `requireAuth` method. Accepts the same shapes as a connection's `auth`:
 * - a `getToken`-only object (static API keys, pre-provisioned JWTs);
 *   `principalType` may be omitted and defaults to `"app"`.
 * - a full interactive OAuth definition (e.g. `connect("okta/myagent")` from
 *   `@vercel/connect/eve`, or `defineInteractiveAuthorization`).
 */
export type ToolAuthDefinition =
  | (Omit<NonInteractiveAuthorizationDefinition, "principalType"> & {
      readonly principalType?: NonInteractiveAuthorizationDefinition["principalType"];
    })
  | AuthorizationDefinition;

export type ToolAuthProvider = ToolAuthDefinition;

/** Controls eve runtime behavior for an inline tool auth provider. */
export interface ToolAuthOptions {
  /**
   * Connection metadata passed through to provider callbacks. Tool-only
   * providers usually leave this unset; connection-backed helpers can use it
   * to receive the upstream server URL.
   */
  readonly connection?: ConnectionAuthorizationContext;
  /**
   * Optional human-readable provider name shown in sign-in UI. Presentation
   * only; it does not affect OAuth scopes, token cache keys, or callback URLs.
   */
  readonly displayName?: string;
  /**
   * Optional eve auth-flow key for token caches, callback URLs, pending
   * authorization state, and authorization completion. This is not an OAuth
   * scope. For Vercel Connect OAuth targeting such as `scopes`, `resources`,
   * or `authorizationDetails`, configure the provider with
   * `connect({ connector, tokenParams })`.
   */
  readonly authKey?: string;
}
