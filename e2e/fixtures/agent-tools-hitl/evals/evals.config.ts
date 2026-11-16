import { e2eJudgeModel } from "@eve-e2e/config";
import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  // e2e-vercel sets EVE_E2E_EVAL_CONCURRENCY: there each eval's work runs on
  // the deployment's functions rather than on the runner, so more run at once.
  maxConcurrency: Number(process.env.EVE_E2E_EVAL_CONCURRENCY ?? 4),
  judge: { model: e2eJudgeModel() },
});
