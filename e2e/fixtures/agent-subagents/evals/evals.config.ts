import { e2eJudgeModel } from "@eve-e2e/config";
import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  judge: { model: e2eJudgeModel() },
  // Evals hold independent sessions on one eval server, and the world-local
  // queue and template preparation accept concurrent evals, so run four at once.
  maxConcurrency: 4,
  timeoutMs: 120_000,
});
