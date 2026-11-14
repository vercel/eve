import { defineEvalConfig } from "eve/evals";
import { DECISION_MODEL } from "../agent/lib/models/config.js";

/**
 * Shared defaults for the evals.
 *
 * @remarks
 * `evals/offline/` runs on mock models (`pnpm eval:offline`) and finishes in seconds.
 * `evals/live/` calls real models through the AI Gateway (`pnpm eval`). Each live case is kept to
 * one narrow turn, so the per-eval timeout is short and concurrency is low. `t.judge` grades with
 * the same decision model the agent uses.
 */
export default defineEvalConfig({
  judge: { model: DECISION_MODEL },
  maxConcurrency: 2,
  timeoutMs: 180_000,
});
