/** Skips evals whose agent turns depend on the scripted mock model. */
export function requireMockModel(t: { skip(reason: string): never }): void {
  if (process.env.EVE_E2E_MODEL !== "mock") {
    t.skip("Requires the deterministic mock model to make the exact loopback calls.");
  }
}
