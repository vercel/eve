interface VercelOidcTokenClaims {
  readonly ownerId: string | undefined;
  readonly projectId: string | undefined;
}

const EMPTY_CLAIMS: VercelOidcTokenClaims = { ownerId: undefined, projectId: undefined };
const VERCEL_OIDC_ISSUER = "https://oidc.vercel.com";

export function isVercelOidcIssuer(issuer: string | undefined): boolean {
  return issuer === VERCEL_OIDC_ISSUER || issuer?.startsWith(`${VERCEL_OIDC_ISSUER}/`) === true;
}

export function decodeVercelOidcTokenClaims(token: string): VercelOidcTokenClaims {
  const payloadSegment = token.split(".")[1];
  if (payloadSegment === undefined || payloadSegment.length === 0) {
    return EMPTY_CLAIMS;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch {
    return EMPTY_CLAIMS;
  }
  if (payload === null || typeof payload !== "object") {
    return EMPTY_CLAIMS;
  }

  const claims = payload as { readonly owner_id?: unknown; readonly project_id?: unknown };
  return {
    ownerId: typeof claims.owner_id === "string" ? claims.owner_id : undefined,
    projectId: typeof claims.project_id === "string" ? claims.project_id : undefined,
  };
}

export function resolveVercelProjectIdFromEnvironment(): string | undefined {
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (projectId !== undefined && projectId.length > 0) {
    return projectId;
  }

  const token = process.env.VERCEL_OIDC_TOKEN?.trim();
  if (token === undefined || token.length === 0) {
    return undefined;
  }

  return decodeVercelOidcTokenClaims(token).projectId;
}
