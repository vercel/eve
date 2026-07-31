import { e2eJudgeModel } from "@eve-e2e/config";
import { defineEvalConfig } from "eve/evals";

/** Judge is unused here; assertions are numeric. Kept for config parity. */
export default defineEvalConfig({
  judge: { model: e2eJudgeModel() },
});
