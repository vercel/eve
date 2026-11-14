import { e2eJudgeModel } from "@eve-e2e/config";
import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  judge: { model: e2eJudgeModel() },
  // Evals hold independent sessions on one eval server, and the world-local
  // queue and template preparation accept concurrent evals, so run four at once.
  // e2e-vercel sets EVE_E2E_EVAL_CONCURRENCY: there each eval's work runs on
  // the deployment's functions rather than on the runner, so more run at once.
  maxConcurrency: Number(process.env.EVE_E2E_EVAL_CONCURRENCY ?? 4),
  timeoutMs: 120_000,
});
