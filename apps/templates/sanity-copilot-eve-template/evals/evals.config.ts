import { defineEvalConfig } from "eve/evals";
import { DECISION_MODEL } from "../agent/lib/models.js";

/**
 * Shared defaults for the evals.
 *
 * @remarks
 * `evals/offline/` runs on mock models (`pnpm eval:offline`) and finishes in seconds;
 * `evals/live/` calls real models through the AI Gateway (`pnpm eval`), so concurrency is kept
 * low and each live case sets its own short `timeoutMs`. `t.judge` grades with the same decision
 * model the researcher's router uses.
 */
export default defineEvalConfig({
  judge: { model: DECISION_MODEL },
  maxConcurrency: 2,
  timeoutMs: 300_000,
});
