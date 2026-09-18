import { e2eJudgeModel } from "@eve-e2e/config";
import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  judge: { model: e2eJudgeModel() },
  maxConcurrency: 1,
  timeoutMs: 240_000,
});
