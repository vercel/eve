import { createHook } from "#compiled/@workflow/core/index.js";
import { claimHookOwnership } from "#execution/hook-ownership.js";

// A bounded replay window, not a guarantee about upstream scheduler republishes.
export const OCCURRENCE_CLAIM_RETENTION = "7d";

export function occurrenceClaimToken(continuationToken: string): string {
  return `eve:occurrence:${continuationToken}`;
}

export function occurrenceAdmittedToken(continuationToken: string, ownerId: string): string {
  return `${occurrenceClaimToken(continuationToken)}:admitted:${ownerId}`;
}

/** Ownership alone is pending; only the second marker certifies successful boot. */
export async function claimOccurrence(continuationToken: string): Promise<void> {
  await claimHookOwnership(
    createHook({
      token: occurrenceClaimToken(continuationToken),
      experimental_minRetention: OCCURRENCE_CLAIM_RETENTION,
    }),
  );
}

/** Neither marker belongs to the inbox, whose cleanup must not release admission. */
export async function markOccurrenceAdmitted(
  continuationToken: string,
  ownerId: string,
): Promise<void> {
  await claimHookOwnership(
    createHook({
      token: occurrenceAdmittedToken(continuationToken, ownerId),
      experimental_minRetention: OCCURRENCE_CLAIM_RETENTION,
    }),
  );
}
