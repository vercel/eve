/** Fixed safety bounds for optional descendant observation, independent of execution budgets. */
export const DESCENDANT_MAX_DEPTH = 8;
export const DESCENDANT_MAX_SESSIONS = 128;
export const DESCENDANT_MAX_READS = 8;

/** Coordinates are data; the owning server verifies the opening at this committed source line. */
export interface DescendantHop {
  readonly sessionId: string;
  readonly position: number;
}

/** Server-established reader namespace and session identity; never contains credentials. */
export const EVE_OBSERVATION_KEY_HEADER = "x-eve-observation-key";

export function localObservationKey(sessionId: string): string {
  return JSON.stringify(["local", sessionId]);
}
