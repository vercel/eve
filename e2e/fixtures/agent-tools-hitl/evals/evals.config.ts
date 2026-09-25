import { e2eJudgeModel } from "@eve-e2e/config";
import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  maxConcurrency: 4,
  judge: { model: e2eJudgeModel() },
});
