import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { readVercelProjectLink } from "#internal/vercel/project-link.js";
import { toErrorMessage } from "#shared/errors.js";
import { z } from "zod";

const VercelOidcClaimsSchema = z.object({
  owner_id: z.string().min(1),
  project_id: z.string().min(1),
});

const LocalDevelopmentUserOidcClaimsSchema = VercelOidcClaimsSchema.extend({
  environment: z.literal("development"),
  user_id: z.string().min(1),
});

/** Vercel owner and project expected to have minted an OIDC token. */
export interface DevelopmentOidcTarget {
  readonly ownerId: string;
  readonly projectId: string;
  /** Ignore an ambient token and ask Vercel for this exact project. */
  readonly forceRefresh?: boolean;
}

type VercelOidcClaimName = keyof z.infer<typeof VercelOidcClaimsSchema>;
type InvalidVercelOidcClaim = VercelOidcClaimName | "claims";

/** Why eve could not use a locally resolved Vercel OIDC token. */
export type DevelopmentOidcTokenFailure =
  | { readonly kind: "resolution-failed"; readonly message: string }
  | {
      readonly kind: "malformed-token";
      readonly reason: "missing-payload" | "invalid-json-payload";
    }
  | {
      readonly kind: "invalid-claims";
      readonly invalidClaims: readonly InvalidVercelOidcClaim[];
    }
  | {
      readonly kind: "target-mismatch";
      readonly mismatchedClaims: readonly VercelOidcClaimName[];
    };

/** Result of resolving and checking a Vercel OIDC token for one target. */
export type DevelopmentOidcTokenResolution =
  | { readonly kind: "resolved"; readonly token: string }
  | DevelopmentOidcTokenFailure;

/**
 * Resolves and claim-checks the local Vercel OIDC token for a verified target.
 * It does not authorize a destination; callers must verify the exact origin
 * first and install the result in a `DevelopmentCredentialGate`.
 */
export async function resolveDevelopmentOidcToken(
  input: DevelopmentOidcTarget,
): Promise<DevelopmentOidcTokenResolution> {
  try {
    const options: NonNullable<Parameters<typeof getVercelOidcToken>[0]> = {
      team: input.ownerId,
      project: input.projectId,
    };
    if (input.forceRefresh === true) options.expirationBufferMs = Number.MAX_SAFE_INTEGER;
    const token = (await getVercelOidcToken(options)).trim();
    return validateDevelopmentOidcToken(token, input);
  } catch (error) {
    return { kind: "resolution-failed", message: toErrorMessage(error) };
  }
}

/**
 * Resolves the current linked project's Vercel OIDC token for a local TUI request.
 *
 * An unavailable token deliberately becomes no bearer, so ordinary local
 * requests still reach `localDev()`; user-scoped Connect requests then report
 * that they need a Vercel user rather than trusting a client-supplied failure.
 */
export async function resolveLinkedDevelopmentOidcToken(workspaceRoot: string): Promise<string> {
  const link = await readVercelProjectLink(workspaceRoot);
  if (link === undefined) return "";

  const target = {
    ownerId: link.orgId,
    projectId: link.projectId,
  };
  const result = await resolveDevelopmentOidcToken(target);
  if (result.kind === "resolved" && isLocalDevelopmentUserToken(result.token)) return result.token;

  // @vercel/oidc can return an unexpired ambient token before it honors the
  // linked target. A local Connect request needs a development user token, so
  // retry only those stale or non-user candidates with an explicit refresh.
  if (result.kind !== "resolved" && result.kind !== "target-mismatch") return "";
  const refreshed = await resolveDevelopmentOidcToken({ ...target, forceRefresh: true });
  return refreshed.kind === "resolved" && isLocalDevelopmentUserToken(refreshed.token)
    ? refreshed.token
    : "";
}

function isLocalDevelopmentUserToken(token: string): boolean {
  const decoded = decodeOidcPayload(token);
  return decoded !== undefined && LocalDevelopmentUserOidcClaimsSchema.safeParse(decoded).success;
}

function validateDevelopmentOidcToken(
  token: string,
  input: DevelopmentOidcTarget,
): Exclude<DevelopmentOidcTokenResolution, { readonly kind: "resolution-failed" }> {
  const decoded = decodeOidcPayload(token);
  if (decoded === undefined) {
    const payload = token.split(".")[1];
    return payload
      ? { kind: "malformed-token", reason: "invalid-json-payload" }
      : { kind: "malformed-token", reason: "missing-payload" };
  }

  const claims = VercelOidcClaimsSchema.safeParse(decoded);
  if (!claims.success) {
    return {
      kind: "invalid-claims",
      invalidClaims: claims.error.issues.map((issue) => {
        const claim = issue.path[0];
        return claim === "owner_id" || claim === "project_id" ? claim : "claims";
      }),
    };
  }

  const mismatchedClaims: VercelOidcClaimName[] = [];
  if (claims.data.owner_id !== input.ownerId) mismatchedClaims.push("owner_id");
  if (claims.data.project_id !== input.projectId) mismatchedClaims.push("project_id");
  if (mismatchedClaims.length > 0) return { kind: "target-mismatch", mismatchedClaims };

  return { kind: "resolved", token };
}

function decodeOidcPayload(token: string): unknown | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Vercel header used to bypass preview protection for framework-owned routes
 * during local CLI development. Paired with a Protection Bypass for
 * Automation token issued from Project Settings.
 */
export const VERCEL_PROTECTION_BYPASS_HEADER = "x-vercel-protection-bypass";
