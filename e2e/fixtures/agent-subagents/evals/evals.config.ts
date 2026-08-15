import { e2eJudgeModel } from "@eve-e2e/config";
import { defineEvalConfig } from "eve/evals";

/** Default judge model for any `t.judge.*` assertion in this fixture. */
export default defineEvalConfig({
  judge: { model: e2eJudgeModel() },
  // Deterministic model turns reach nested Workflow waits immediately. Keep
  // separate evals from competing with the child workflows they are testing.
  maxConcurrency: 1,
  timeoutMs: 120_000,
});
