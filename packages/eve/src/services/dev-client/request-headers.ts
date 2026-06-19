import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { z } from "zod";

/** Hostnames served by the local development runtime. */
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);
const VercelOidcClaimsSchema = z.object({
  owner_id: z.string().min(1),
  project_id: z.string().min(1),
});

function isLocalEveServerUrl(url: URL): boolean {
  return LOCAL_HOSTNAMES.has(url.hostname);
}

/**
 * Returns whether `serverUrl` targets a recognized local development host.
 * Invalid URLs are treated as remote.
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
 * Asks `@vercel/oidc` for a token scoped to the verified owner and project,
 * validates the returned claims, and returns an empty string when verification
 * fails. Refresh and repair are owned by the explicit remote-auth flow.
 */
export async function resolveDevelopmentOidcToken(input: {
  readonly ownerId: string;
  readonly projectId: string;
}): Promise<string> {
  try {
    const token = (
      await getVercelOidcToken({ team: input.ownerId, project: input.projectId })
    ).trim();
    return tokenMatchesProject(token, input) ? token : "";
  } catch {
    return "";
  }
}

function tokenMatchesProject(
  token: string,
  input: { readonly ownerId: string; readonly projectId: string },
): boolean {
  const payload = token.split(".")[1];
  if (payload === undefined) return false;

  try {
    const claims = VercelOidcClaimsSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return (
      claims.success &&
      claims.data.owner_id === input.ownerId &&
      claims.data.project_id === input.projectId
    );
  } catch {
    return false;
  }
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
