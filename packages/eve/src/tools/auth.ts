import type {
  ConnectionAuthorizationContext,
  AuthorizationDefinition,
  TokenResult,
} from "#shared/connection-types.js";

/**
 * Authorization provider passed to the tool context's `getToken` or
 * `requireAuth` method. Accepts the same shapes as a connection's `auth`:
 * - a `getToken`-only object (static API keys, pre-provisioned JWTs);
 *   `principalType` may be omitted and defaults to `"app"`.
 * - a full interactive OAuth definition (e.g. `connect("okta/myagent")` from
 *   `@vercel/connect/eve`, or `defineInteractiveAuthorization`), which keeps
 *   `principalType: "user"`.
 */
export type ToolAuthDefinition = AuthorizationDefinition;

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

/**
 * The caller's sign-in, in a tool and in the agent's dynamic `model`. Both methods take the same
 * providers as a connection's `auth` field, including `connect("...")` from `@vercel/connect/eve`,
 * and one call can use several providers. Each context says how its work continues after the
 * sign-in.
 */
export interface SignInMethods {
  /**
   * Returns the caller's token for `provider`. When the caller has no token, eve opens the sign-in
   * and continues the work once the caller signs in.
   */
  getToken(provider: ToolAuthProvider, options?: ToolAuthOptions): Promise<TokenResult>;
  /**
   * Drops the provider's cached token and starts a sign-in. Call it when the provider rejects a
   * token from {@link getToken}, such as with a `401`.
   */
  requireAuth(provider: ToolAuthProvider, options?: ToolAuthOptions): never;
}
