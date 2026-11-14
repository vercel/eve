import { defineEvalConfig } from "eve/evals";

import { computeGroundTruth } from "./lib/ground-truth.js";

/**
 * Evals run against the seeded demo database (`pnpm db:seed`, then `pnpm db:setup-sql --apply`).
 *
 * @remarks Setup computes expected answers from the live data before the agent server starts.
 */
export default defineEvalConfig({
  judge: { model: "openai/gpt-6-luna-decisions" },
  async setup() {
    return { truth: await computeGroundTruth() };
  },
  timeoutMs: 240_000,
});
