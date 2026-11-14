import { defineEvalConfig } from "eve/evals";
import { DECISION_MODEL } from "../agent/lib/models.js";

/**
 * Shared defaults for the evals.
 *
 * @remarks
 * `evals/offline/` runs on mock models (`pnpm eval:offline`) and finishes in seconds;
 * `evals/live/` calls real models through the AI Gateway (`pnpm eval`), where a research or
 * review turn can take minutes, so the per-eval timeout is generous and concurrency is kept low.
 * `t.judge` grades with the same decision model the agent uses.
 */
export default defineEvalConfig({
  judge: { model: DECISION_MODEL },
  maxConcurrency: 2,
  timeoutMs: 600_000,
});
