/**
 * Protocol-agnostic interfaces for the connection system.
 *
 * Framework tools (`connection_search`) and the context provider
 * depend only on these interfaces, not on any
 * protocol-specific implementation such as MCP.
 */

import type { ToolSet } from "ai";

import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";
import type { NeedsApprovalContext } from "#public/definitions/tool.js";
import type { JsonValue } from "#public/types/json.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

/**
 * Credential returned by a connection's `getToken` or
 * `completeAuthorization`.
 *
 * `token` is the bearer string sent as `Authorization: Bearer <token>`.
 *
 * `expiresAt` is an optional absolute expiration in **milliseconds since
 * the Unix epoch** ({@link Date.now}). Advisory: the runtime may refresh a
 * cached token before the next call based on it, but is not required to.
 */
export interface TokenResult {
  readonly token: string;
  readonly expiresAt?: number;
}

/**
 * Wire protocol a connection speaks.
 *
 * Stamped onto a connection definition by the `define*` factory that
 * produced it (`defineMcpClientConnection` → `"mcp"`,
 * `defineOpenAPIConnection` → `"openapi"`) and carried through the
 * compiled manifest so the runtime registry can pick the matching
 * client implementation. Never authored directly.
 */
export type ConnectionProtocol = "mcp" | "openapi";

/** A single header value, supporting static strings and dynamic resolution. */
export type HeaderValue = string | Promise<string> | (() => string | Promise<string>);

/**
 * Arbitrary HTTP headers sent with every request to a connection server.
 *
 * Static form: key-value pairs where each value may be a string, Promise,
 * or function. Function form: a callback returning the full headers map,
 * useful when multiple headers must be resolved together.
 */
export type HeadersDefinition =
  | Readonly<Record<string, HeaderValue>>
  | (() => Record<string, string> | Promise<Record<string, string>>);

/**
 * Client-side tool filter applied after `listTools()`.
 *
 * Specify exactly one of `allow` or `block`:
 * - `allow`: the model sees only the named tools.
 * - `block`: the model sees all tools except the named ones.
 */
export type ToolFilterDefinition =
  | { readonly allow: readonly string[] }
  | { readonly block: readonly string[] };

/**
 * Framework-resolved identity on whose behalf a connection is
 * authenticating. The runtime derives this from
 * {@link AuthorizationDefinition.principalType} plus the active
 * session and hands it to every callback.
 *
 * - `{ type: "app" }`: shared agent identity; one token per
 *   connection across all sessions.
 * - `{ type: "user", id, issuer }`: per end-user identity; the token
 *   cache keys on `issuer + id` so the same `id` across different
 *   IdPs (Slack `U123` vs Google `U123`) never collides.
 */
export type ConnectionPrincipal =
  | { readonly type: "app" }
  | {
      readonly type: "user";
      readonly id: string;
      readonly issuer: string;
      readonly attributes?: Readonly<Record<string, string | readonly string[]>>;
    };

/**
 * Parsed projection of the OAuth callback the framework received at the
 * connection's callback URL.
 *
 * Request headers are intentionally excluded. `completeAuthorization`
 * consumes the IdP's returned values (`code`, `state`, and so on) from
 * {@link params}, never request headers, so inbound cookies and
 * `Authorization` headers never cross a step boundary.
 */
export interface AuthorizationCallback {
  /** Query-string params merged with form-encoded body params. */
  readonly params: Readonly<Record<string, string>>;
  readonly method: string;
  /** Raw request body, present only for non-GET callbacks (`form_post`). */
  readonly body?: string;
}

/**
 * Per-connection metadata the framework hands to every authorization
 * callback alongside the resolved {@link ConnectionPrincipal}.
 *
 * Currently exposes the connection's declared MCP server `url`, which
 * helper-based `getToken` implementations (e.g. `@vercel/connect/eve`)
 * use to provision the credential lazily on first use without
 * re-declaring the URL.
 *
 * Strictly additive: new fields may appear over time, so callbacks that
 * destructure only the fields they need are forward-compatible.
 */
export interface ConnectionAuthorizationContext {
  /**
   * The MCP server URL declared on `defineMcpClientConnection`, verbatim
   * from the definition. The runtime does not normalize or validate it
   * beyond the definition's own schema.
   */
  readonly url: string;
}

/**
 * Authorization strategy for a connection. Two shapes, chosen by
 * which optional methods are present:
 *
 * 1. **`getToken`-only**: the runtime probes {@link getToken} per
 *    tool invocation. Throwing
 *    {@link ConnectionAuthorizationRequiredError} emits a
 *    `authorization.required` event; the workflow does
 *    not suspend on a webhook. Works for both `"app"` and `"user"`
 *    principal types.
 * 2. **Full interactive OAuth**: all three methods provided. The
 *    runtime catches `Required` from {@link getToken}, runs
 *    {@link startAuthorization} in a durable step, suspends the
 *    turn on a framework-owned webhook, and finishes with
 *    {@link completeAuthorization}. Restricted to
 *    `principalType: "user"` in v1: interactive OAuth implies a
 *    human completing a browser flow, so an `"app"` principal has
 *    no one to send the authorization URL to.
 *
 * {@link startAuthorization} and {@link completeAuthorization} are
 * both-or-neither; providing exactly one is a definition error.
 *
 * `Resume` is constrained to {@link JsonValue} so the `resume` value
 * handed from `startAuthorization` to `completeAuthorization` is
 * guaranteed JSON-serializable.
 */
export type AuthorizationDefinition<Resume extends JsonValue = JsonValue> =
  | NonInteractiveAuthorizationDefinition
  | InteractiveAuthorizationDefinition<Resume>;

/**
 * Protocol-agnostic `auth` shape accepted by every connection
 * `define*` factory (`defineMcpClientConnection`,
 * `defineOpenAPIConnection`, and so on).
 *
 * Identical to {@link AuthorizationDefinition} except the
 * non-interactive form may omit `principalType`; normalization
 * defaults it to `"app"`. The resolved token is sent as
 * `Authorization: Bearer <token>`.
 */
export type ConnectionAuthDefinition =
  | (Omit<NonInteractiveAuthorizationDefinition, "principalType"> & {
      readonly principalType?: NonInteractiveAuthorizationDefinition["principalType"];
    })
  | AuthorizationDefinition;

/**
 * Fields shared by every {@link AuthorizationDefinition} shape.
 */
interface AuthorizationDefinitionBase {
  /**
   * Declares whether this connection acts as the agent itself (one
   * shared credential) or on behalf of the end-user (per-principal
   * tokens). Runtime definitions always carry this field; public
   * `getToken`-only `auth` definitions default it to `"app"` during
   * normalization when authors omit it.
   *
   * - `"app"`: the framework passes `{ type: "app" }` to every callback
   *   regardless of who called the agent. The token cache keys on
   *   `"app"` and is shared across all sessions.
   * - `"user"`: the framework projects the active session's user
   *   principal into `{ type: "user", id, issuer, ... }` and fails
   *   fast with `reason: "principal_required"` when the session has
   *   no authenticated user. The token cache keys on
   *   `user:${issuer}:${id}` so concurrent users never share tokens.
   */
  readonly principalType: "app" | "user";

  /**
   * Optional metadata marker attached by `connect()` from
   * `@vercel/connect/eve` so downstream tooling can detect Vercel
   * Connect-backed connections at compile time without inspecting
   * `getToken`'s closure state. Examples: a future eve compiler step
   * that surfaces connector identifiers in build output, or the Vercel
   * dashboard rendering deep links to a connector's settings page.
   *
   * The runtime token-fetch path ignores this field; it is purely
   * provider attribution. Authors writing their own `getToken`
   * callbacks (raw bearer tokens, custom callbacks) should leave it
   * unset.
   *
   * `connector` carries whatever value the author passed to
   * `connect()`: a UID like `"oauth/mcp-linear-app"` or opaque
   * `"scl_..."`. Both forms address the same connector on the Vercel
   * Connect side.
   */
  readonly vercelConnect?: {
    readonly connector: string;
  };

  /**
   * Optional human-readable provider name shown in sign-in UI (e.g.
   * `"Salesforce"`). Presentation-only: the authorization scope, token
   * cache keys, and callback URLs all stay keyed by the path-derived
   * name. Takes precedence over a `displayName` the strategy stamps on
   * its {@link ConnectionAuthorizationChallenge}; channels fall back to
   * title-casing the scope name when neither is set.
   */
  readonly displayName?: string;

  /**
   * Optional best-effort invalidation of any token cache the strategy
   * owns *below* eve's per-step cache, for the given `principal`.
   *
   * eve always drops its own per-step entry when a resolved bearer is
   * rejected (a downstream `401` mapped to `ctx.requireAuth()`, or the
   * MCP server rejecting the token). But a strategy frequently sits on a
   * second, longer-lived cache — most notably the `@vercel/connect`
   * in-process token cache — that eve cannot see. Without this hook the
   * re-authorization re-reads the same revoked-but-unexpired credential
   * from that lower layer and the tool keeps failing.
   *
   * Implement `evict` to purge the strategy's own cache for `principal`
   * so the next `getToken` performs a genuine refresh. The runtime calls
   * it right after evicting the per-step entry, inside the same
   * best-effort guard: throwing here must never mask the underlying
   * authorization error, so implementations should swallow their own
   * failures or stay side-effect-only. Leave it unset for strategies
   * that hold no cache of their own (static keys, raw bearers).
   */
  evict?(opts: {
    readonly principal: ConnectionPrincipal;
    readonly connection: ConnectionAuthorizationContext;
  }): void | Promise<void>;
}

/**
 * Non-interactive authorization: the runtime only ever calls
 * {@link getToken}. Use for static API keys, pre-provisioned JWTs,
 * or out-of-band OAuth flows where authorization lives outside the
 * agent turn.
 */
export interface NonInteractiveAuthorizationDefinition extends AuthorizationDefinitionBase {
  /**
   * Probe for a cached or freshly-fetched token. Called before every
   * tool invocation. Throw
   * {@link ConnectionAuthorizationRequiredError} to signal that the
   * user must complete authorization out of band; the runtime emits
   * `authorization.required` and does not suspend on a
   * webhook.
   */
  getToken(opts: {
    readonly principal: ConnectionPrincipal;
    readonly connection: ConnectionAuthorizationContext;
  }): Promise<TokenResult>;

  readonly startAuthorization?: undefined;
  readonly completeAuthorization?: undefined;
}

/**
 * Interactive authorization: the runtime suspends the turn on a
 * framework-owned webhook, drives the OAuth consent flow, and
 * re-executes the tool with the resulting token on resume.
 *
 * Restricted to `principalType: "user"` in v1: OAuth consent is
 * fundamentally user-scoped, and app-scoped interactive flows raise
 * scope-by-first-user, concurrent-bootstrap-race, and
 * revocation-ambiguity problems left behind an explicit opt-in.
 */
export interface InteractiveAuthorizationDefinition<
  Resume = JsonValue,
> extends AuthorizationDefinitionBase {
  readonly principalType: "user";

  /**
   * Probe for a cached or freshly-fetched token.
   *
   * Called before every tool invocation on the connection. Returning
   * a {@link TokenResult} lets the tool run. Throwing
   * {@link ConnectionAuthorizationRequiredError} signals that the
   * user must complete an authorization flow; the runtime emits a
   * `authorization.required` event and suspends the turn
   * on a framework-owned webhook while it runs
   * {@link startAuthorization}.
   */
  getToken(opts: {
    readonly principal: ConnectionPrincipal;
    readonly connection: ConnectionAuthorizationContext;
  }): Promise<TokenResult>;

  /**
   * Start an authorization flow. Invoked inside a durable step after the
   * runtime mints a framework-owned callback URL. Returns the user-facing
   * `challenge` (forwarded verbatim on `authorization.required`) and an
   * optional serializable `resume` value (e.g. a PKCE verifier) that the
   * runtime journals and hands back to {@link completeAuthorization} when
   * the callback URL receives the provider redirect. Omit `resume` when
   * the provider owns the flow state server-side.
   */
  startAuthorization(opts: {
    readonly principal: ConnectionPrincipal;
    readonly connection: ConnectionAuthorizationContext;
    readonly callbackUrl: string;
  }): Promise<{
    readonly challenge: ConnectionAuthorizationChallenge;
    /**
     * Opaque, JSON-serializable value the strategy carries from
     * `startAuthorization` to {@link completeAuthorization} (e.g. a PKCE
     * verifier). Serialized across workflow steps to survive the park.
     * Omit it when the provider owns the flow state server-side
     * (e.g. Vercel Connect).
     */
    readonly resume?: Resume;
  }>;

  /**
   * Finish an authorization flow.
   *
   * Receives the journaled `resume` value (whatever
   * {@link startAuthorization} returned, absent for provider-owned
   * flows), the framework-minted `callbackUrl`, and the parsed
   * `callback` projection (params only, no request headers). Return a
   * {@link TokenResult}; throw a `ConnectionAuthorizationFailedError`
   * with `retryable: false` for terminal user-denied cases.
   */
  completeAuthorization(opts: {
    readonly principal: ConnectionPrincipal;
    readonly connection: ConnectionAuthorizationContext;
    readonly callbackUrl: string;
    /** The value the strategy returned from {@link startAuthorization}'s `resume` (absent for provider-owned flows). */
    readonly resume?: Resume;
    /** Parsed callback params (no request headers). */
    readonly callback: AuthorizationCallback;
  }): Promise<TokenResult>;
}

/**
 * Interactive authorization strategy with type-safe state flowing from
 * {@link InteractiveAuthorizationDefinition.startAuthorization} to
 * {@link InteractiveAuthorizationDefinition.completeAuthorization}.
 *
 * Defaults `principalType` to `"user"` (the only valid value in v1).
 *
 * Pass the `Resume` type argument explicitly (e.g.
 * `defineInteractiveAuthorization<{ verifier: string }>(...)`) to type the
 * value carried from `startAuthorization` to `completeAuthorization`. It
 * defaults to `never`, so when omitted no `resume` value can be returned.
 *
 * @example
 * ```ts
 * defineInteractiveAuthorization<{ verifier: string }>({
 *   getToken: async ({ principal }) => ({ token: cached }),
 *   startAuthorization: async ({ principal, callbackUrl }) => ({
 *     challenge: { url: `https://idp.example/auth?redirect=${callbackUrl}` },
 *     resume: { verifier: pkceVerifier },
 *   }),
 *   completeAuthorization: async ({ principal, resume, callback }) => {
 *     // resume is typed as { verifier: string } | undefined
 *     const token = await exchange(resume!.verifier, callback.params.code);
 *     return { token };
 *   },
 * })
 * ```
 */
export function defineInteractiveAuthorization<Resume extends JsonValue = never>(
  definition: Omit<InteractiveAuthorizationDefinition<Resume>, "principalType">,
): InteractiveAuthorizationDefinition<Resume> {
  return { ...definition, principalType: "user" };
}

/**
 * Whether an authorization definition supports the framework-owned
 * interactive OAuth flow.
 */
export function supportsInteractiveAuthorization(
  authorization: Readonly<AuthorizationDefinition> | undefined,
): boolean {
  return authorization?.startAuthorization !== undefined;
}

/** Metadata for a single tool exposed by a connection. */
export interface ConnectionToolMetadata {
  readonly annotations?: Record<string, unknown>;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly name: string;
  readonly outputSchema?: Record<string, unknown>;
}

/** A live client for a single connection. */
export interface ConnectionClient {
  close(): Promise<void>;
  connect(): Promise<unknown>;
  executeTool(toolName: string, args: unknown): Promise<unknown>;
  getToolMetadata(): Promise<readonly ConnectionToolMetadata[]>;
  getTools(): Promise<ToolSet>;
}

/** Per-session container mapping connection names to clients. */
export interface ConnectionRegistry {
  dispose(): Promise<void>;
  getClient(connectionName: string): ConnectionClient;
  getConnectionApproval(
    connectionName: string,
  ): ((ctx: NeedsApprovalContext) => boolean) | undefined;
  getConnectionNames(): readonly string[];
  getConnections(): readonly ResolvedConnectionDefinition[];
}
