/**
 * Claims eve reads from a Vercel OIDC token payload.
 *
 * Decoded locally without signature verification: callers use the values
 * as stable identifiers (sandbox key derivation, credential routing),
 * never to make authentication decisions.
 */
export interface VercelOidcTokenClaims {
  readonly ownerId: string | undefined;
  readonly projectId: string | undefined;
}

const EMPTY_CLAIMS: VercelOidcTokenClaims = { ownerId: undefined, projectId: undefined };

/**
 * Decodes the payload claims of a Vercel OIDC token. Values that are not
 * decodable JWTs, or that carry no recognized claims, decode to empty
 * claims — callers only ever check individual fields.
 */
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

/**
 * Resolves the Vercel project id visible to this process: the
 * `VERCEL_PROJECT_ID` env var when exposed, otherwise the `project_id`
 * claim of `VERCEL_OIDC_TOKEN`. Both sources exist at build time and at
 * deployed runtime and name the same project, so identifiers derived
 * from this value agree across the two phases.
 */
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
