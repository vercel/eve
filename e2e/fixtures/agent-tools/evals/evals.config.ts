import { e2eJudgeModel } from "@eve-e2e/config";
import { defineEvalConfig } from "eve/evals";

/** Default judge model for any `t.judge.*` assertion in this fixture. */
export default defineEvalConfig({
  judge: { model: e2eJudgeModel() },
});
