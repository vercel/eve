import { e2eJudgeModel } from "@eve-e2e/config";
import { defineEvalConfig } from "eve/evals";
import { evalLifecycleReporter } from "./reporter.js";

export default defineEvalConfig({
  judge: { model: e2eJudgeModel() },
  reporters: [evalLifecycleReporter],
});
