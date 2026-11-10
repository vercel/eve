import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { decodeVercelOidcTokenClaims } from "#shared/vercel-project.js";
import { withPackageUserAgent } from "#internal/user-agent.js";
import type { VercelCreateOptions } from "#execution/sandbox/bindings/vercel-sdk-types.js";

export function getVercelSandboxFetch(createOptions: VercelCreateOptions): typeof globalThis.fetch {
  const fetchOverride = Reflect.get(createOptions, "fetch");
  return withPackageUserAgent(typeof fetchOverride === "function" ? fetchOverride : undefined);
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
  const withIds = (token: string | undefined): VercelSandboxCredentials | undefined =>
    token && teamId && projectId ? { projectId, teamId, token } : undefined;

  const explicit = withIds(readNonEmptyString(createOptions, "token"));
  if (explicit) {
    return explicit;
  }

  const accessToken = withIds(readNonEmptyEnvironmentVariable("VERCEL_TOKEN"));
  if (accessToken && !readNonEmptyEnvironmentVariable("VERCEL_OIDC_TOKEN")) {
    return accessToken;
  }

  // Never send `VERCEL_OIDC_TOKEN` as-is: it can expire before it is used, for
  // example when a build starts long after its environment was issued. The
  // helper rejects an expired token, refreshing it where it can.
  try {
    const oidcToken = await getVercelOidcToken({ project: projectId, team: teamId });
    return withIds(oidcToken) ?? getVercelSandboxCredentialsFromOidcToken(oidcToken);
  } catch (error) {
    if (accessToken) {
      return accessToken;
    }
    throw error;
  }
}

/** Credentials when eve can resolve them; otherwise `{}` so the SDK falls back to its own resolution. */
export async function resolveVercelSandboxCredentials(
  createOptions: VercelCreateOptions,
): Promise<VercelSandboxCredentials | Record<string, never>> {
  try {
    return await getVercelSandboxCredentials(createOptions);
  } catch {
    return {};
  }
}

function readNonEmptyString(object: object, key: string): string | undefined {
  const value = Reflect.get(object, key);
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
