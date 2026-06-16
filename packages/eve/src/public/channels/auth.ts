/**
 * Route-level HTTP authentication primitives.
 *
 * Strategy helpers return an {@link AuthFn} for route factories. Verifier
 * helpers are lower-level pure functions for custom `fetch` handlers.
 */

import { decodeJwt } from "#compiled/jose/index.js";

import type { SessionAuthContext } from "#channel/types.js";
import { createLogger } from "#internal/logging.js";
import { authenticateHttpBasicStrategy } from "#runtime/governance/auth/http-basic.js";
import { authenticateJwtEcdsaStrategy } from "#runtime/governance/auth/jwt-ecdsa.js";
import { authenticateJwtHmacStrategy } from "#runtime/governance/auth/jwt-hmac.js";
import { authenticateOidcStrategy } from "#runtime/governance/auth/oidc.js";
import {
  createRuntimeSessionAuthContext,
  type ResolvedJwtEcdsaAuthStrategy,
  type ResolvedJwtHmacAuthStrategy,
  type ResolvedOidcAuthStrategy,
  type RouteStrategyAuthenticationResult,
} from "#runtime/governance/auth/types.js";

const vercelOidcLog = createLogger("auth.vercel-oidc");
import {
  createRuntimeIpAllowList,
  isRuntimeIpAllowed,
  type RuntimeIpAllowList,
} from "#runtime/governance/network/ip-allow-list.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Result returned by the verifier helpers below. On success, `sessionAuth`
 * is a fully-constructed {@link SessionAuthContext}; on failure no detail is
 * returned so routes do not leak which credential check failed.
 */
export type VerifyResult =
  | { readonly ok: true; readonly sessionAuth: SessionAuthContext }
  | { readonly ok: false };

// ---------------------------------------------------------------------------
// HTTP Basic
// ---------------------------------------------------------------------------

/**
 * Credentials accepted by {@link verifyHttpBasic}.
 */
export interface HttpBasicCredentials {
  readonly username: string;
  readonly password: string;
}

/**
 * Verifies an HTTP Basic credential against the supplied username and
 * password. Returns `{ ok: true, sessionAuth }` on success or `{ ok: false }`
 * on a missing or mismatched credential. The password is compared with
 * constant-time hash equality so a timing side channel cannot leak it; the
 * username is compared directly.
 */
export function verifyHttpBasic(
  authorizationHeader: string | null,
  credentials: HttpBasicCredentials,
): VerifyResult {
  if (authorizationHeader === null) {
    return { ok: false };
  }

  const result = authenticateHttpBasicStrategy({
    authorization: authorizationHeader,
    strategy: {
      kind: "http-basic",
      password: credentials.password,
      username: credentials.username,
    },
  });

  if (result.kind !== "authenticated") {
    return { ok: false };
  }

  return {
    ok: true,
    sessionAuth: createRuntimeSessionAuthContext(result.principal),
  };
}

// ---------------------------------------------------------------------------
// JWT HMAC
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link verifyJwtHmac}. Optional fields have defaults so
 * adapters can omit unused matchers. `secret` is read by the adapter from its
 * secret store (e.g. `process.env`) and passed in directly.
 */
export interface VerifyJwtHmacConfig {
  readonly algorithm: "HS256" | "HS384" | "HS512";
  readonly audiences: readonly string[];
  readonly issuer: string;
  readonly secret: string;
  /**
   * Tolerance in seconds for the `exp` and `nbf` claims. Defaults to 30.
   */
  readonly clockSkewSeconds?: number;
  /**
   * AWS IAM-style `*`-wildcard patterns matched against the token `sub`.
   * When supplied, the token is rejected unless one matches.
   */
  readonly subjects?: readonly string[];
  /**
   * Per-claim membership matcher: each named claim must contain at least one
   * of the listed values, or the token is rejected.
   */
  readonly claims?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Verifies a bearer JWT signed with an HMAC secret. Pass the token without
 * the `Bearer ` prefix (see {@link extractBearerToken}). Returns
 * `{ ok: true, sessionAuth }` on success or `{ ok: false }` when verification
 * fails or the token's claims don't match the supplied matchers.
 */
export async function verifyJwtHmac(
  token: string | null,
  config: VerifyJwtHmacConfig,
): Promise<VerifyResult> {
  if (token === null || token.length === 0) {
    return { ok: false };
  }

  const strategy: ResolvedJwtHmacAuthStrategy = {
    algorithm: config.algorithm,
    audiences: [...config.audiences],
    clockSkewSeconds: config.clockSkewSeconds ?? 30,
    issuer: config.issuer,
    kind: "jwt-hmac",
    secret: config.secret,
    ...(config.claims === undefined ? {} : { claims: config.claims }),
    ...(config.subjects === undefined ? {} : { subjects: config.subjects }),
  };

  const result = await authenticateJwtHmacStrategy({ strategy, token });
  if (result.kind !== "authenticated") {
    return { ok: false };
  }

  return {
    ok: true,
    sessionAuth: createRuntimeSessionAuthContext(result.principal),
  };
}

// ---------------------------------------------------------------------------
// JWT ECDSA
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link verifyJwtEcdsa}.
 */
export interface VerifyJwtEcdsaConfig {
  readonly algorithm: "ES256" | "ES384" | "ES512";
  readonly audiences: readonly string[];
  readonly issuer: string;
  /**
   * PEM-encoded ECDSA public key (`-----BEGIN PUBLIC KEY-----` ...).
   */
  readonly publicKey: string;
  /**
   * Tolerance in seconds for the `exp` and `nbf` claims. Defaults to 30.
   */
  readonly clockSkewSeconds?: number;
  /**
   * AWS IAM-style `*`-wildcard patterns matched against the token `sub`.
   * When supplied, the token is rejected unless one matches.
   */
  readonly subjects?: readonly string[];
  /**
   * Per-claim membership matcher: each named claim must contain at least one
   * of the listed values, or the token is rejected.
   */
  readonly claims?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Verifies a bearer JWT signed with an ECDSA private key against the supplied
 * PEM public key. Pass the token without the `Bearer ` prefix (see
 * {@link extractBearerToken}). Returns `{ ok: true, sessionAuth }` on success
 * or `{ ok: false }` when verification fails or the token's claims do not
 * match the configured `subjects`/`claims`.
 */
export async function verifyJwtEcdsa(
  token: string | null,
  config: VerifyJwtEcdsaConfig,
): Promise<VerifyResult> {
  if (token === null || token.length === 0) {
    return { ok: false };
  }

  const strategy: ResolvedJwtEcdsaAuthStrategy = {
    algorithm: config.algorithm,
    audiences: [...config.audiences],
    clockSkewSeconds: config.clockSkewSeconds ?? 30,
    issuer: config.issuer,
    kind: "jwt-ecdsa",
    publicKey: config.publicKey,
    ...(config.claims === undefined ? {} : { claims: config.claims }),
    ...(config.subjects === undefined ? {} : { subjects: config.subjects }),
  };

  const result = await authenticateJwtEcdsaStrategy({ strategy, token });
  if (result.kind !== "authenticated") {
    return { ok: false };
  }

  return {
    ok: true,
    sessionAuth: createRuntimeSessionAuthContext(result.principal),
  };
}

// ---------------------------------------------------------------------------
// OIDC
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link verifyOidc}.
 */
export interface VerifyOidcConfig {
  readonly audiences: readonly string[];
  readonly issuer: string;
  /**
   * OIDC discovery URL. Defaults to
   * `${issuer}/.well-known/openid-configuration` (any trailing slash on
   * `issuer` is stripped first).
   */
  readonly discoveryUrl?: string;
  /**
   * Tolerance in seconds for the `exp` and `nbf` claims. Defaults to 30.
   */
  readonly clockSkewSeconds?: number;
  /**
   * AWS IAM-style `*`-wildcard patterns matched against the token `sub`.
   * When supplied, the token is rejected unless one matches.
   */
  readonly subjects?: readonly string[];
  /**
   * Per-claim membership matcher: each named claim must contain at least one
   * of the listed values, or the token is rejected.
   */
  readonly claims?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Verifies a bearer OIDC token against an issuer's discovery URL. Pass the
 * token without the `Bearer ` prefix (see {@link extractBearerToken}). The
 * token must satisfy the configured `subjects`/`claims` matchers; on success
 * the principal is tagged `principalType: "service"`. Unlike
 * {@link verifyVercelOidc}, this never grants the Vercel current-project
 * bypass. Returns `{ ok: false }` on failed verification or matchers.
 */
export async function verifyOidc(
  token: string | null,
  config: VerifyOidcConfig,
): Promise<VerifyResult> {
  const result = await runOidcVerification(token, {
    ...config,
    acceptCurrentVercelProject: false,
  });
  return result.kind === "authenticated"
    ? { ok: true, sessionAuth: createRuntimeSessionAuthContext(result.principal) }
    : { ok: false };
}

/**
 * Runs OIDC token verification against a resolved strategy and returns
 * the strategy authenticator's tagged result. Internal helper shared
 * between {@link verifyOidc} (public, never grants the Vercel
 * current-project upgrade) and {@link verifyVercelOidc} (always opts
 * into it). Returning the raw outcome rather than a boolean lets call
 * sites log a structured rejection reason.
 */
async function runOidcVerification(
  token: string | null,
  config: VerifyOidcConfig & { readonly acceptCurrentVercelProject: boolean },
): Promise<RouteStrategyAuthenticationResult> {
  if (token === null || token.length === 0) {
    return { kind: "not-authenticated" };
  }

  const strategy: ResolvedOidcAuthStrategy = {
    acceptCurrentVercelProject: config.acceptCurrentVercelProject,
    audiences: [...config.audiences],
    clockSkewSeconds: config.clockSkewSeconds ?? 30,
    discoveryUrl:
      config.discoveryUrl ?? `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    issuer: config.issuer,
    kind: "oidc",
    ...(config.claims === undefined ? {} : { claims: config.claims }),
    ...(config.subjects === undefined ? {} : { subjects: config.subjects }),
  };

  return await authenticateOidcStrategy({ strategy, token });
}

// ---------------------------------------------------------------------------
// Bearer token extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the bearer token from an `Authorization: Bearer <token>` header.
 * Returns `null` if the header is missing, the scheme isn't `Bearer`, or the
 * value after `Bearer ` is empty.
 */
export function extractBearerToken(authorizationHeader: string | null): string | null {
  if (authorizationHeader === null) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
  const value = match?.[1]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

// ---------------------------------------------------------------------------
// IP allowlist
// ---------------------------------------------------------------------------

/**
 * Parsed IP allowlist for repeated checks. Construct once at module load,
 * then call {@link isIpAllowed} per request.
 */
export type IpAllowList = RuntimeIpAllowList;

/**
 * Parses exact IP addresses or CIDR blocks into a reusable
 * {@link IpAllowList}. Entries are trimmed; throws on an empty entry, a `*`
 * wildcard (use exact IP/CIDR syntax), or an invalid address or CIDR prefix.
 */
export function createIpAllowList(entries: readonly string[]): IpAllowList {
  return createRuntimeIpAllowList(entries);
}

/**
 * Returns whether `ip` is permitted by `allowList`. `null` always returns
 * `false`. Adapters that need to allow unknown IPs should not call this.
 */
export function isIpAllowed(ip: string | null, allowList: IpAllowList): boolean {
  if (ip === null) {
    return false;
  }
  return isRuntimeIpAllowed(ip, allowList);
}

// ---------------------------------------------------------------------------
// Unauthorized response builder
// ---------------------------------------------------------------------------

/**
 * One challenge entry attached to the `www-authenticate` header on a failure
 * response. For a Basic+Bearer prompt, pass both:
 * `[{ scheme: "Basic", parameters: { realm: "agent" } }, { scheme: "Bearer" }]`
 */
export interface UnauthorizedChallenge {
  readonly scheme: "Basic" | "Bearer";
  readonly parameters?: Readonly<Record<string, string>>;
}

/**
 * Options accepted by {@link createUnauthorizedResponse}.
 */
export interface UnauthorizedResponseOptions {
  /**
   * HTTP status code. Defaults to `401`. Use `403` for "authenticated but
   * not allowed" outcomes.
   */
  readonly status?: 401 | 403;
  /**
   * Machine-readable error code returned in the JSON body. Defaults to
   * `"unauthorized"` (401) or `"forbidden"` (403).
   */
  readonly code?: string;
  /**
   * Human-readable error message returned in the JSON body. Defaults to a
   * generic prompt.
   */
  readonly message?: string;
  /**
   * Optional `www-authenticate` challenge entries.
   */
  readonly challenges?: readonly UnauthorizedChallenge[];
}

/**
 * Builds a JSON failure response shaped like the framework's other auth
 * failures: `cache-control: no-store`, one `www-authenticate` header per
 * challenge, and a `{ ok: false, code, error }` body.
 */
export function createUnauthorizedResponse(opts: UnauthorizedResponseOptions = {}): Response {
  const status = opts.status ?? 401;
  const code = opts.code ?? (status === 403 ? "forbidden" : "unauthorized");
  const message =
    opts.message ?? (status === 403 ? "Forbidden." : "Authorization is required for this route.");
  const challenges = opts.challenges ?? [];

  const headers = new Headers({ "cache-control": "no-store" });
  for (const challenge of challenges) {
    headers.append("www-authenticate", formatChallenge(challenge));
  }

  return Response.json(
    {
      code,
      error: message,
      ok: false,
    },
    {
      headers,
      status,
    },
  );
}

function formatChallenge(challenge: UnauthorizedChallenge): string {
  if (challenge.parameters === undefined || Object.keys(challenge.parameters).length === 0) {
    return challenge.scheme;
  }
  const renderedParameters = Object.entries(challenge.parameters)
    .map(([key, value]) => `${key}="${escapeChallengeValue(value)}"`)
    .join(", ");
  return `${challenge.scheme} ${renderedParameters}`;
}

function escapeChallengeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * Options accepted by auth error classes. The class chooses the HTTP status.
 */
export type AuthErrorOptions = Omit<UnauthorizedResponseOptions, "status">;

/**
 * Error thrown by auth callbacks to reject a route with a structured 401
 * response. `routeAuth` catches it and returns its response; other errors
 * propagate through the normal channel failure path.
 */
export class UnauthenticatedError extends Error {
  readonly response: Response;

  constructor(opts: AuthErrorOptions = {}) {
    super(opts.message ?? "Authorization is required for this route.");
    this.name = "UnauthenticatedError";
    this.response = createUnauthorizedResponse({ ...opts, status: 401 });
  }
}

/**
 * Error thrown by auth callbacks to reject a route with a structured 403
 * response. `routeAuth` catches it and returns its response; other errors
 * propagate through the normal channel failure path.
 */
export class ForbiddenError extends Error {
  readonly response: Response;

  constructor(opts: AuthErrorOptions = {}) {
    super(opts.message ?? "Forbidden.");
    this.name = "ForbiddenError";
    this.response = createUnauthorizedResponse({ ...opts, status: 403 });
  }
}

/**
 * Route auth callback. Returned value semantics inside {@link routeAuth}:
 *
 * - A {@link SessionAuthContext} accepts the request and halts the walk.
 * - `null` or `undefined` skips to the next entry.
 *
 * If every entry skips (including the empty `[]` case), the walker returns a
 * 401. To reject with a specific response, throw an
 * {@link UnauthenticatedError} or {@link ForbiddenError}. To accept anonymous
 * traffic, include {@link none} as the final entry.
 */
export type AuthFn<TEvent = Request> = (
  event: TEvent,
) => SessionAuthContext | null | undefined | Promise<SessionAuthContext | null | undefined>;

/**
 * Walks an `AuthFn` (or array) in order against `request`. The first entry
 * returning a {@link SessionAuthContext} wins; entries returning `null` or
 * `undefined` are skipped. If the walk exhausts without a winner (including
 * the empty-array case), returns a 401 {@link createUnauthorizedResponse}.
 *
 * Channel factories that share this resolution policy (e.g. `eveChannel`, or
 * a custom `defineChannel` route handler) should call `routeAuth` rather than
 * re-implement the walk.
 */
export async function routeAuth(
  request: Request,
  auth: AuthFn<Request> | readonly AuthFn<Request>[],
): Promise<SessionAuthContext | Response> {
  const list: readonly AuthFn<Request>[] = Array.isArray(auth)
    ? (auth as readonly AuthFn<Request>[])
    : [auth as AuthFn<Request>];

  try {
    for (const fn of list) {
      const result = await fn(request);
      if (result) return result;
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "response" in error &&
      error.response instanceof Response
    ) {
      return error.response;
    }
    throw error;
  }

  return createUnauthorizedResponse({ challenges: [{ scheme: "Bearer" }] });
}

/**
 * Returns an {@link AuthFn} for scaffolded apps that makes unfinished
 * production auth fail as an intentional 401 rather than an internal route
 * error. Replace it before serving real users:
 *
 * ```ts
 * eveChannel({ auth: [localDev(), vercelOidc(), placeholderAuth()] });
 * ```
 *
 * Outside production it returns `null`, so the auth walk keeps the same local
 * development behavior as any other skipped entry.
 */
export function placeholderAuth(): AuthFn<Request> {
  return () => {
    if (process.env.VERCEL_ENV !== "production") {
      return null;
    }

    throw new UnauthenticatedError({
      code: "eve_production_auth_not_configured",
      message:
        "Production auth is not configured. Replace placeholderAuth() in agent/channels/eve.ts with your app's auth provider.",
    });
  };
}

/**
 * Returns an {@link AuthFn} that accepts any request anonymously, producing
 * a synthetic principal with `principalType: "anonymous"`. Use it as the
 * final entry in an `auth` array to opt routes into unauthenticated access:
 *
 * ```ts
 * eveChannel({ auth: [none()] }); // every request accepted anonymously
 * ```
 *
 * The returned `SessionAuthContext` halts the {@link routeAuth} walk, so
 * `none()` terminates whatever array it appears in. It ignores its event
 * argument, so `TEvent` is inferred from the surrounding array (defaulting
 * to `unknown`) and composes with `AuthFn<Request>` entries without a type
 * argument.
 */
export function none<TEvent = unknown>(): AuthFn<TEvent> {
  return () => ANONYMOUS_SESSION_AUTH_CONTEXT;
}

/**
 * Returns an {@link AuthFn} that authenticates requests during local
 * development, keyed on the request URL's hostname (not the host process).
 * A hostname is treated as loopback when it is `localhost` or any
 * `*.localhost` subdomain (RFC 6761 routes the `.localhost` TLD to
 * loopback), any IPv4 in `127.0.0.0/8`, or the IPv6 loopback `::1`.
 *
 * Matching requests get a synthetic principal with `principalType:
 * "local-dev"`. Every other request returns `null`, skipping to the next
 * entry under {@link routeAuth}, which makes `[localDev(), vercelOidc()]`
 * the canonical "open on localhost, Vercel OIDC in prod" pattern.
 *
 * The check is not based on bare `process.env.VERCEL`: a deployment
 * outside Vercel (Fly, Railway, raw container) leaves `VERCEL` unset and
 * would then accept every public request. The one process-level exception
 * is `vercel dev`, detected by `VERCEL=1` and `VERCEL_ENV=development`
 * together. Only the local `vercel dev` server sets that pair (preview and
 * production report `VERCEL_ENV=preview`/`production`), so it opens the
 * dev server (which may serve over a non-loopback host) without opening a
 * real deployment.
 *
 * Caveat: this assumes a sane edge in front of public origins. An origin
 * that trusts an attacker-controlled `Host` header (no CDN, no normalizing
 * reverse proxy) lets an attacker spoof `Host: localhost` and reach
 * `localDev()`. Layer a real authenticator on such deployments.
 */
export function localDev(): AuthFn<Request> {
  return (request) => {
    if (process.env.VERCEL && process.env.VERCEL_ENV === "development") {
      return LOCAL_DEV_SESSION_AUTH_CONTEXT;
    }
    if (!isLoopbackRequest(request)) {
      return null;
    }
    return LOCAL_DEV_SESSION_AUTH_CONTEXT;
  };
}

/**
 * Hostnames {@link localDev} treats as loopback, in addition to the
 * `*.localhost` wildcard and the `127.0.0.0/8` range. `0.0.0.0` is
 * intentionally excluded — it is the "all interfaces" sentinel, not a
 * loopback address, and requests claiming it as their host generally
 * originate from somewhere else on the network.
 *
 * Node's `URL.hostname` preserves brackets around IPv6 addresses (the
 * WHATWG-serialized form), so the IPv6 loopback is recognized as the
 * literal `"[::1]"` rather than `"::1"`.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "[::1]"]);

/**
 * `127.0.0.0/8` is the full IPv4 loopback block — every `127.x.x.x`
 * address resolves to the same machine, and dev tools sometimes bind
 * to addresses other than `127.0.0.1` for multi-instance setups.
 */
const LOOPBACK_IPV4_PREFIX = /^127\./;

function isLoopbackRequest(request: Request): boolean {
  let hostname: string;
  try {
    hostname = new URL(request.url).hostname;
  } catch {
    return false;
  }
  if (LOOPBACK_HOSTNAMES.has(hostname)) {
    return true;
  }
  if (LOOPBACK_IPV4_PREFIX.test(hostname)) {
    return true;
  }
  // RFC 6761: the entire `.localhost` TLD is reserved for loopback.
  if (hostname.endsWith(".localhost")) {
    return true;
  }
  return false;
}

const ANONYMOUS_SESSION_AUTH_CONTEXT: SessionAuthContext = {
  attributes: {},
  authenticator: "none",
  principalId: "anonymous",
  principalType: "anonymous",
};

const LOCAL_DEV_SESSION_AUTH_CONTEXT: SessionAuthContext = {
  attributes: {},
  authenticator: "local-dev",
  principalId: "local-dev",
  principalType: "local-dev",
};

const VERCEL_OIDC_ISSUER_PREFIX = "https://oidc.vercel.com/";

/**
 * Expected prefix for the `aud` claim of a Vercel-minted OIDC token
 * (`https://vercel.com/<owner-slug>`). Requiring it gives a real audience
 * binding: `verifyVercelOidc` otherwise verifies the token only against its
 * own `aud` (a tautology), so a token the project minted for a foreign
 * federation audience (e.g. AWS STS) — same `project_id`, different `aud` —
 * could be replayed against the agent. Foreign audiences lack this prefix and
 * are rejected; every owner's Vercel audience carries it, so the cross-project
 * `subjects` path is unaffected.
 */
const VERCEL_OIDC_AUDIENCE_PREFIX = "https://vercel.com/";

/**
 * Options for {@link verifyVercelOidc} and {@link vercelOidc}.
 */
export interface VerifyVercelOidcOptions {
  /**
   * Optional `sub` patterns granting callers access on top of the always-on
   * current-project bypass. Patterns use AWS IAM-style `*` wildcards and may
   * target tokens minted by other Vercel projects (e.g.
   * `"owner:acme:project:partner-agent:environment:*"`). The current project
   * is always accepted regardless of this list.
   */
  readonly subjects?: readonly string[];
}

/**
 * Verifies a bearer JWT minted by Vercel OIDC.
 *
 * Acceptance rule:
 *
 * - Tokens whose `project_id` matches `VERCEL_PROJECT_ID` are **always**
 *   accepted regardless of `subjects`, so the deployment's own runtime
 *   callers (subagent, internal fetches) authenticate without being
 *   enumerated.
 * - Tokens with an `external_sub` claim authenticate as
 *   `principalType: "user"` when they match the current `VERCEL_PROJECT_ID`
 *   (if set) and `VERCEL_TARGET_ENV` / `VERCEL_ENV` (if set). `external_sub`
 *   becomes the eve subject, `external_iss` or `connector_id` the eve issuer
 *   when present, and string-valued OIDC profile claims (`name`, `picture`,
 *   `email`) are exposed as auth attributes.
 * - Tokens from other Vercel projects are accepted **only** when their `sub`
 *   matches one of {@link VerifyVercelOidcOptions.subjects}.
 *
 * The `environment` claim is not constrained: production, preview, and
 * development tokens for the current project all authenticate. Non-user
 * principals are tagged `"runtime"` when the token's `environment` matches
 * the current deployment, otherwise `"service"`.
 */
export async function verifyVercelOidc(
  token: string | null,
  opts: VerifyVercelOidcOptions = {},
): Promise<VerifyResult> {
  if (token === null || token.length === 0) {
    return { ok: false };
  }

  const claims = decodeUnverifiedJwtClaims(token);
  if (claims === null) {
    vercelOidcLog.debug("Rejected token that failed to decode as a JWT.");
    return { ok: false };
  }

  if (!claims.issuer.startsWith(VERCEL_OIDC_ISSUER_PREFIX)) {
    vercelOidcLog.debug("Rejected token whose issuer is not a Vercel OIDC issuer.", {
      issuer: claims.issuer,
    });
    return { ok: false };
  }

  if (claims.audiences.length === 0) {
    vercelOidcLog.debug("Rejected token with no audience claim.", { issuer: claims.issuer });
    return { ok: false };
  }

  // Bind the audience: the token must carry a Vercel audience. The verifier
  // below otherwise checks the token's `aud` against itself (a tautology), so
  // without this a token minted for a foreign federation audience would still
  // authenticate on a matching `project_id`.
  if (!claims.audiences.some((audience) => audience.startsWith(VERCEL_OIDC_AUDIENCE_PREFIX))) {
    vercelOidcLog.debug("Rejected token whose audience is not a Vercel audience.", {
      audiences: claims.audiences,
      issuer: claims.issuer,
    });
    return { ok: false };
  }

  // `acceptCurrentVercelProject: true` activates the same-project bypass
  // inside the OIDC verifier so any token minted for `VERCEL_PROJECT_ID`
  // is accepted regardless of `subjects`. The supplied `subjects`
  // matcher (defaulting to an empty list that matches nothing)
  // determines which **other** callers are allowed in.
  const result = await runOidcVerification(token, {
    acceptCurrentVercelProject: true,
    audiences: claims.audiences,
    issuer: claims.issuer,
    subjects: opts.subjects ?? [],
  });

  if (result.kind === "authenticated") {
    vercelOidcLog.debug("Accepted Vercel OIDC token.", {
      issuer: claims.issuer,
      principalType: result.principal.principalType,
      subject: result.principal.subject,
    });
    return { ok: true, sessionAuth: createRuntimeSessionAuthContext(result.principal) };
  }

  vercelOidcLog.debug("Rejected Vercel OIDC token after verification.", {
    audiences: claims.audiences,
    issuer: claims.issuer,
    reason: result.kind,
    subjectsConfigured: (opts.subjects ?? []).length > 0,
    ...(result.kind === "misconfigured" ? { detail: result.message } : {}),
  });
  return { ok: false };
}

/**
 * Allowed values for {@link VercelSubjectInput.environment}. Use `"*"`
 * to match any of `production`, `preview`, and `development` for the
 * named project.
 */
export type VercelSubjectEnvironment = "production" | "preview" | "development" | "*";

/**
 * Strict input shape accepted by {@link vercelSubject}.
 *
 * The `sub` claim carries human-readable slugs/names, not IDs. Stable
 * project and team IDs (`prj_...`, `team_...`) live on the separate
 * `project_id` / `owner_id` claims, which `verifyVercelOidc` matches
 * against `VERCEL_PROJECT_ID` for the current-project bind. This helper
 * composes a `sub` matcher, so its inputs are slugs.
 */
export interface VercelSubjectInput {
  /**
   * Vercel team slug (a.k.a. "owner"; e.g. `"acme"`) as embedded in the
   * `sub` claim, **not** the stable team ID `team_...` (`VERCEL_TEAM_ID`).
   *
   * Must not contain `*` or `:` so authors cannot widen the matcher to
   * "any team with a project of this name". Hand-write the subject string
   * when cross-team federation is intentional.
   */
  readonly teamSlug: string;
  /**
   * Vercel project name (e.g. `"acme_website"`) as embedded in the `sub`
   * claim, **not** the stable project ID `prj_...` (`VERCEL_PROJECT_ID`).
   * Same constraints as {@link teamSlug}.
   */
  readonly projectName: string;
  /**
   * Vercel deployment environment, or `"*"` to match any environment for
   * the named project. Defaults to `"production"` so an unspecified
   * environment cannot silently accept preview/development tokens.
   */
  readonly environment?: VercelSubjectEnvironment;
}

/**
 * Builds a Vercel OIDC `sub` matcher pattern from a typed input.
 *
 * Vercel-issued tokens carry a `sub` of the form
 * `owner:[TEAM_SLUG]:project:[PROJECT_NAME]:environment:[ENVIRONMENT]`.
 * Hand-writing it invites two foot-guns: a misspelled slug (silently
 * rejecting all callers) and over-broad wildcards (silently accepting
 * unrelated callers). This helper rejects malformed inputs at construction
 * time and forces an explicit `environment`.
 *
 * Use it inside {@link VerifyVercelOidcOptions.subjects} to layer
 * additional Vercel-project callers on top of the current-project bypass:
 *
 * ```ts
 * vercelOidc({
 *   subjects: [vercelSubject({ teamSlug: "partner", projectName: "data" })],
 * });
 * ```
 *
 * The `sub` claim flips when a team or project name changes, so any policy
 * built on this helper must update with it; the stable team/project IDs are
 * not exposed in `sub`. See Vercel's OIDC reference for the token anatomy.
 */
export function vercelSubject(input: VercelSubjectInput): string {
  assertVercelSubjectSegment("teamSlug", input.teamSlug);
  assertVercelSubjectSegment("projectName", input.projectName);
  const environment = input.environment ?? "production";
  if (
    environment !== "production" &&
    environment !== "preview" &&
    environment !== "development" &&
    environment !== "*"
  ) {
    throw new Error(
      `vercelSubject: invalid environment ${JSON.stringify(environment)}; expected "production", "preview", "development", or "*".`,
    );
  }
  return `owner:${input.teamSlug}:project:${input.projectName}:environment:${environment}`;
}

function assertVercelSubjectSegment(field: "teamSlug" | "projectName", value: string): void {
  if (value.length === 0) {
    throw new Error(`vercelSubject: ${field} must be a non-empty string.`);
  }
  if (value.includes("*") || value.includes(":")) {
    throw new Error(
      `vercelSubject: ${field} ${JSON.stringify(value)} may not contain ${value.includes(":") ? "':'" : "'*'"}. Hand-write the subject string when wildcards are intentional.`,
    );
  }
}

/**
 * Returns an HTTP route auth callback backed by Vercel OIDC. See
 * {@link verifyVercelOidc} for the always-on current-project bypass and how
 * `subjects` extends acceptance to other Vercel projects.
 */
export function vercelOidc(opts: VerifyVercelOidcOptions = {}): AuthFn<Request> {
  return async (request) => {
    const token = extractBearerToken(request.headers.get("authorization"));
    const result = await verifyVercelOidc(token, opts);
    return result.ok ? result.sessionAuth : null;
  };
}

/** Returns an {@link AuthFn} that verifies HTTP Basic credentials via {@link verifyHttpBasic}. */
export function httpBasic(credentials: HttpBasicCredentials): AuthFn<Request> {
  return (request) => {
    const result = verifyHttpBasic(request.headers.get("authorization"), credentials);
    return result.ok ? result.sessionAuth : null;
  };
}

/** Returns an {@link AuthFn} that verifies an HMAC-signed bearer JWT via {@link verifyJwtHmac}. */
export function jwtHmac(config: VerifyJwtHmacConfig): AuthFn<Request> {
  return async (request) => {
    const token = extractBearerToken(request.headers.get("authorization"));
    const result = await verifyJwtHmac(token, config);
    return result.ok ? result.sessionAuth : null;
  };
}

/** Returns an {@link AuthFn} that verifies an ECDSA-signed bearer JWT via {@link verifyJwtEcdsa}. */
export function jwtEcdsa(config: VerifyJwtEcdsaConfig): AuthFn<Request> {
  return async (request) => {
    const token = extractBearerToken(request.headers.get("authorization"));
    const result = await verifyJwtEcdsa(token, config);
    return result.ok ? result.sessionAuth : null;
  };
}

/**
 * Returns an {@link AuthFn} that verifies an OIDC bearer token on the inbound
 * request via {@link verifyOidc}. Use {@link vercelOidc} instead for
 * Vercel-issued tokens: it preconfigures the issuer, audience, and runtime
 * principal flag.
 */
export function oidc(config: VerifyOidcConfig): AuthFn<Request> {
  return async (request) => {
    const token = extractBearerToken(request.headers.get("authorization"));
    const result = await verifyOidc(token, config);
    return result.ok ? result.sessionAuth : null;
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Decodes a bearer JWT into its issuer and audience(s) without verifying
 * the signature. Returns `null` for malformed tokens or tokens missing
 * the `iss` claim.
 *
 * Used by {@link verifyVercelOidc} to discover the team-scoped issuer and
 * audience baked into Vercel-issued tokens before running full
 * verification.
 */
function decodeUnverifiedJwtClaims(
  token: string,
): { readonly issuer: string; readonly audiences: readonly string[] } | null {
  let payload: ReturnType<typeof decodeJwt>;
  try {
    payload = decodeJwt(token);
  } catch {
    return null;
  }

  if (typeof payload.iss !== "string" || payload.iss.length === 0) {
    return null;
  }

  const audiences =
    typeof payload.aud === "string"
      ? [payload.aud]
      : Array.isArray(payload.aud)
        ? payload.aud.filter((value): value is string => typeof value === "string")
        : [];

  return { audiences, issuer: payload.iss };
}
