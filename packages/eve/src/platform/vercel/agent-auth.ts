import { VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER } from "#client/types.js";
import type { OutboundAuthFn } from "#public/agents/auth.js";

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
 * Returns an {@link OutboundAuthFn} that emits a Vercel OIDC token in both the
 * bearer and trusted-identity-provider headers for outbound remote-agent
 * requests. The bearer authenticates the eve route, while the trusted header
 * passes Vercel Deployment Protection.
 *
 * Reads the token from the request context or the `VERCEL_OIDC_TOKEN`
 * environment variable (refreshed in development when expired). Pass
 * {@link VercelOidcOptions} to scope the refresh to a team or project; defaults
 * to `{}`.
 */
export function vercelOidc(options: VercelOidcOptions = {}): OutboundAuthFn {
  return async () => {
    const { getVercelOidcToken } = await import("#compiled/@vercel/oidc/index.js");
    const token = await getVercelOidcToken(options);
    return {
      headers: {
        authorization: `Bearer ${token}`,
        [VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER]: token,
      },
    };
  };
}
