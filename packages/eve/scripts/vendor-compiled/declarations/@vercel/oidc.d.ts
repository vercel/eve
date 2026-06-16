// Minimal declaration for the vendored slice of `@vercel/oidc`. The
// upstream package fans out `index.d.ts` across four sibling files
// (`get-vercel-oidc-token`, `get-context`, `auth-errors`, `token-util`),
// most of which eve never references. Only `getVercelOidcToken` is used
// from this package; other helpers can be added here if a future caller
// reaches for them.

export interface GetVercelOidcTokenOptions {
  /** Optional team ID (`team_*`) or slug to use for token refresh. */
  team?: string;
  /** Optional project ID (`prj_*`) or slug to use for token refresh. */
  project?: string;
  /** Buffer in milliseconds before token expiry that triggers a refresh. */
  expirationBufferMs?: number;
}

/**
 * Returns the OIDC token from the request context or `VERCEL_OIDC_TOKEN`,
 * refreshing it in a development environment when it is expired.
 */
export declare function getVercelOidcToken(options?: GetVercelOidcTokenOptions): Promise<string>;
