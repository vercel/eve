import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import type { VercelCreateOptions } from "#execution/sandbox/bindings/vercel-sdk-types.js";

export function getVercelSandboxFetch(createOptions: VercelCreateOptions): typeof globalThis.fetch {
  return createOptions.fetch ?? globalThis.fetch;
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
  const value = Reflect.get(object, key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNonEmptyEnvironmentVariable(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getVercelSandboxCredentialsFromOidcToken(token: string): VercelSandboxCredentials {
  const payloadSegment = token.split(".")[1];
  if (payloadSegment === undefined) {
    throw new Error("Invalid Vercel OIDC token: missing payload.");
  }

  const payload: unknown = JSON.parse(
    Buffer.from(base64UrlToBase64(payloadSegment), "base64").toString("utf8"),
  );
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Invalid Vercel OIDC token: payload must be an object.");
  }
  const claims = payload as Record<string, unknown>;
  const teamId = typeof claims.owner_id === "string" ? claims.owner_id : undefined;
  const projectId = typeof claims.project_id === "string" ? claims.project_id : undefined;

  if (teamId === undefined || projectId === undefined) {
    throw new Error("Invalid Vercel OIDC token: missing owner_id or project_id.");
  }

  return { projectId, teamId, token };
}

function base64UrlToBase64(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
}

export interface VercelSandboxCredentials {
  readonly projectId: string;
  readonly teamId: string;
  readonly token: string;
}
