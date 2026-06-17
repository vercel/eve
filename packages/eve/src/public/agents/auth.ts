import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";

import type { TokenValue } from "#client/types.js";

/**
 * Outbound request auth hook for remote agent dispatch. Runs once per
 * outbound request; returns the headers (e.g. `authorization`) to merge onto
 * that request. Use {@link vercelOidc}, {@link bearer}, or {@link basic} to
 * construct one, or supply a custom function for other schemes.
 */
export type OutboundAuthFn = () => Promise<{
  readonly headers: Readonly<Record<string, string>>;
}>;

/**
 * eve-owned mirror of the `@vercel/oidc` token lookup options forwarded to
 * {@link vercelOidc}.
 */
export interface VercelOidcOptions {
  /** Buffer in milliseconds before token expiry that triggers a refresh. */
  readonly expirationBufferMs?: number;
  /** Project ID (`prj_*`) or slug to use for token refresh. */
  readonly project?: string;
  /** Team ID (`team_*`) or slug to use for token refresh. */
  readonly team?: string;
}

/**
 * Returns an {@link OutboundAuthFn} that emits a `Bearer` Vercel OIDC token for
 * outbound remote-agent requests. Reads the token from the request context or
 * the `VERCEL_OIDC_TOKEN` environment variable (refreshed in development when
 * expired). Pass {@link VercelOidcOptions} to scope the refresh to a team or
 * project; defaults to `{}`.
 */
export function vercelOidc(options: VercelOidcOptions = {}): OutboundAuthFn {
  return async () => ({
    headers: {
      authorization: `Bearer ${await getVercelOidcToken(options)}`,
    },
  });
}

/**
 * Returns an {@link OutboundAuthFn} that emits a `Bearer` `Authorization`
 * header. `token` is a {@link TokenValue}: pass a string for a static token, or
 * a function to resolve a fresh token on each outbound request.
 */
export function bearer(token: TokenValue): OutboundAuthFn {
  return async () => ({
    headers: {
      authorization: `Bearer ${await resolveTokenValue(token)}`,
    },
  });
}

/**
 * Returns an {@link OutboundAuthFn} that emits an HTTP Basic `Authorization`
 * header. `username` is a literal string; `password` is a {@link TokenValue}
 * (static string or per-request resolver). Base64-encodes the credentials per
 * request.
 */
export function basic(input: {
  readonly password: TokenValue;
  readonly username: string;
}): OutboundAuthFn {
  return async () => {
    const encodedCredentials = btoa(`${input.username}:${await resolveTokenValue(input.password)}`);

    return {
      headers: {
        authorization: `Basic ${encodedCredentials}`,
      },
    };
  };
}

async function resolveTokenValue(value: TokenValue): Promise<string> {
  return typeof value === "function" ? await value() : value;
}
