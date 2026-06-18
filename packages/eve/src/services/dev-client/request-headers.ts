import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";

/**
 * Hostnames the dev client treats as "local" for auth purposes. When the
 * target server is one of these, the dev client skips the Vercel OIDC
 * bearer entirely — the framework's default channel auth chain is
 * `[localDev(), vercelOidc()]`, and `localDev()` accepts off Vercel
 * infrastructure, so attaching a bearer would be wasted work and noise
 * in the request inspector.
 */
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

function isLocalEveServerUrl(url: URL): boolean {
  return LOCAL_HOSTNAMES.has(url.hostname);
}

/**
 * Returns whether `serverUrl` targets one of the recognized local
 * development hostnames. Invalid URLs return `false` so callers can
 * always proceed as if the target is remote.
 */
export function isLocalDevelopmentServerUrl(serverUrl: string): boolean {
  try {
    return isLocalEveServerUrl(new URL(serverUrl));
  } catch {
    return false;
  }
}

/**
 * Resolves the locally available Vercel OIDC token. This function does not
 * authorize a destination; callers must first verify the exact deployment
 * origin and install the result in a `DevelopmentCredentialGate`.
 *
 * Tries the `@vercel/oidc` SDK first (refreshes a freshly-issued token
 * when the CLI is linked to a Vercel project), then falls back to the
 * `VERCEL_OIDC_TOKEN` environment variable. Returns an empty string
 * when no token is available so callers can proceed without auth.
 */
export async function resolveDevelopmentOidcToken(): Promise<string> {
  try {
    const token = (await getVercelOidcToken()).trim();

    if (token.length > 0) {
      return token;
    }
  } catch {
    // Fall through to env var.
  }

  return process.env.VERCEL_OIDC_TOKEN?.trim() ?? "";
}

/**
 * Vercel header used to bypass preview protection for framework-owned routes
 * during local CLI development. Paired with a Protection Bypass for
 * Automation token issued from Project Settings.
 */
export const VERCEL_PROTECTION_BYPASS_HEADER = "x-vercel-protection-bypass";

/**
 * Vercel header used to bypass deployment protection by presenting a
 * trusted OIDC token issued by Vercel for the linked project. When the
 * CLI is `vercel link`-ed (or running inside a Vercel function), the
 * platform mints an OIDC token whose audience and subject match the
 * deployment, and accepts it as proof that the caller is authorized.
 *
 * This is preferred over {@link VERCEL_PROTECTION_BYPASS_HEADER} because
 * it requires no per-project secret — the token is already available via
 * `@vercel/oidc`.
 */
export const VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER = "x-vercel-trusted-oidc-idp-token";

/**
 * Vercel request header that carries the runtime OIDC token on function
 * invocations.
 */
export const VERCEL_OIDC_TOKEN_HEADER = "x-vercel-oidc-token";
