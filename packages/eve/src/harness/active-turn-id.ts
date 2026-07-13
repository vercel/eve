import type { HarnessEmissionState } from "#harness/emission.js";

/**
 * Returns the id of the in-flight turn, or — between turns — the id the
 * next turn will mint (`turn_${sequence}`, the same formula
 * `emitTurnPreamble` uses). Callers that need to address a turn before
 * its preamble persists (eg. the cancellation turn guard) use this to
 * agree with the emitted id.
 *
 * Lives in a leaf module so `"use workflow"` bodies can import it
 * without pulling harness emission (and its Node builtins) into the
 * workflow bundle.
 */
export function activeTurnId(state: HarnessEmissionState): string {
  return state.turnId === "" ? `turn_${state.sequence}` : state.turnId;
}
