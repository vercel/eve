import type { EveEvalContext } from "eve/evals";

export const GUARDED_ECHO_TOKEN = "guarded-echo-ok-T4Q9";

/**
 * These evals encode the transition catalog in
 * research/hitl-request-lifecycle.md before the interpreter and lifecycle
 * event stages land. Until then they skip; flipping this flag activates them
 * as the acceptance suite for those stages.
 */
export const LIFECYCLE_CONTRACT_ACTIVE = process.env.EVE_HITL_LIFECYCLE_CONTRACT === "1";

/** Skips the eval until the lifecycle contract stages are implemented. */
export function gateLifecycle(t: EveEvalContext): void {
  if (!LIFECYCLE_CONTRACT_ACTIVE) {
    t.skip(
      "HITL lifecycle contract not active yet; set EVE_HITL_LIFECYCLE_CONTRACT=1 " +
        "once the behavior and lifecycle-event stages land " +
        "(research/hitl-request-lifecycle.md).",
    );
  }
}
