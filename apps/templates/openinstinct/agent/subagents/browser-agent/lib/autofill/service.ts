import type { AccessScope } from "@shared/identity/access-scope";
import type {
  AutofillClaim,
  AutofillSuggestion,
  DetectedAutofillSurface,
} from "./protocol";

export interface AutofillFillTarget {
  readonly availableTokens: ReadonlySet<string>;
  readonly origin: string;
  readonly surface: DetectedAutofillSurface;
}

export interface AutofillVaultAdapter {
  listSuggestions(
    scope: AccessScope,
    origin: string,
    surface: DetectedAutofillSurface
  ): Promise<readonly AutofillSuggestion[]>;
  materializeClaims(
    scope: AccessScope,
    candidateId: string,
    target: AutofillFillTarget
  ): Promise<readonly AutofillClaim[]>;
}

export async function listAutofillSuggestions(
  scope: AccessScope,
  origin: string,
  surface: DetectedAutofillSurface,
  adapter: AutofillVaultAdapter
) {
  return adapter.listSuggestions(scope, origin, surface);
}

export async function materializeAutofillClaims(
  scope: AccessScope,
  candidateId: string,
  target: AutofillFillTarget,
  adapter: AutofillVaultAdapter
) {
  const claims = await adapter.materializeClaims(scope, candidateId, target);
  if (claims.length === 0) {
    throw new Error("The selected vault item has no values for this form.");
  }
  return claims;
}
