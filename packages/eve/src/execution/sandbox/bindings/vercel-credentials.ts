import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { decodeVercelOidcTokenClaims } from "#shared/vercel-project.js";
import { withEveSandboxUserAgent } from "#execution/sandbox/bindings/vercel-user-agent.js";
import type { VercelCreateOptions } from "#execution/sandbox/bindings/vercel-sdk-types.js";

export function getVercelSandboxFetch(createOptions: VercelCreateOptions): typeof globalThis.fetch {
  const fetchOverride = (createOptions as { readonly fetch?: typeof globalThis.fetch }).fetch;
  return withEveSandboxUserAgent(fetchOverride ?? globalThis.fetch);
}

export async function getVercelSandboxCredentials(
  createOptions: VercelCreateOptions,
): Promise<VercelSandboxCredentials> {
  const teamId =
    readNonEmptyString(createOptions, "teamId") ??
    readNonEmptyEnvironmentVariable("VERCEL_TEAM_ID") ??
    readNonEmptyEnvironmentVariable("VERCEL_ORG_ID");
  const projectId =
    readNonEmptyString(createOptions, "projectId") ??
    readNonEmptyEnvironmentVariable("VERCEL_PROJECT_ID");
  const envToken =
    readNonEmptyString(createOptions, "token") ??
    readNonEmptyEnvironmentVariable("VERCEL_OIDC_TOKEN") ??
    readNonEmptyEnvironmentVariable("VERCEL_TOKEN");

  if (envToken && teamId && projectId) {
    return { projectId, teamId, token: envToken };
  }

  const oidcToken = await getVercelOidcToken({
    project: projectId,
    team: teamId,
  });
  return getVercelSandboxCredentialsFromOidcToken(oidcToken);
}

function readNonEmptyString(object: object, key: string): string | undefined {
  const value = (object as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNonEmptyEnvironmentVariable(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getVercelSandboxCredentialsFromOidcToken(token: string): VercelSandboxCredentials {
  const claims = decodeVercelOidcTokenClaims(token);
  if (claims.ownerId === undefined || claims.projectId === undefined) {
    throw new Error("Invalid Vercel OIDC token: missing owner_id or project_id.");
  }

  return { projectId: claims.projectId, teamId: claims.ownerId, token };
}

export interface VercelSandboxCredentials {
  readonly projectId: string;
  readonly teamId: string;
  readonly token: string;
}
