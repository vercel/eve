import type { EveEvalContext } from "eve/evals";

/** Skips an eval whose scripted calls only the deterministic mock model makes. */
export function requireMockModel(t: EveEvalContext): void {
  if (process.env.EVE_E2E_MODEL !== "mock") {
    t.skip("Requires the deterministic mock model to issue the exact calls.");
  }
}
