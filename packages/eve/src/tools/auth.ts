import type {
  ConnectionAuthorizationContext,
  AuthorizationDefinition,
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
  /**
   * The `principalId` of the person whose token to read, instead of the caller's. It names
   * someone who has spoken in the session, as the sender lines the model reads name them. Naming
   * the caller is the same as omitting it.
   *
   * eve hands out the named person's token when they sent the latest message the model read as it
   * made the call, or when they approved the call. Otherwise eve asks them to approve the call,
   * and signs them in if they haven't connected, where the session can ask; elsewhere the call
   * fails with `reason: "confirmation_required"`. The agent's `callerConfirmation` doesn't apply
   * to a person who isn't the caller.
   *
   * eve keeps a person's identity but not their attributes, so a provider that reads
   * `principal.attributes` receives none for the named person. Fails with
   * `reason: "principal_not_found"` when no one who has spoken has this `principalId`, and with
   * `reason: "principal_ambiguous"` when more than one has. A local subagent can name the people
   * who had spoken in the session that delegated to it. Only a tool's own `ctx.getToken` and
   * `ctx.requireAuth` take it, in a tool that runs in the session's turn.
   */
  readonly as?: string;
}
