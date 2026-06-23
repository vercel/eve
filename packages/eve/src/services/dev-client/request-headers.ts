import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { toErrorMessage } from "#shared/errors.js";
import { z } from "zod";

const VercelOidcClaimsSchema = z.object({
  owner_id: z.string().min(1),
  project_id: z.string().min(1),
});

/** Vercel owner and project expected to have minted an OIDC token. */
export interface DevelopmentOidcTarget {
  readonly ownerId: string;
  readonly projectId: string;
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
    const token = (
      await getVercelOidcToken({ team: input.ownerId, project: input.projectId })
    ).trim();
    return validateDevelopmentOidcToken(token, input);
  } catch (error) {
    return { kind: "resolution-failed", message: toErrorMessage(error) };
  }
}

function validateDevelopmentOidcToken(
  token: string,
  input: DevelopmentOidcTarget,
): Exclude<DevelopmentOidcTokenResolution, { readonly kind: "resolution-failed" }> {
  const payload = token.split(".")[1];
  if (!payload) return { kind: "malformed-token", reason: "missing-payload" };

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { kind: "malformed-token", reason: "invalid-json-payload" };
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

/**
 * Vercel header used to bypass preview protection for framework-owned routes
 * during local CLI development. Paired with a Protection Bypass for
 * Automation token issued from Project Settings.
 */
export const VERCEL_PROTECTION_BYPASS_HEADER = "x-vercel-protection-bypass";
