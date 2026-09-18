import { defineEvalConfig } from "eve/evals";
import { evalLifecycleReporter } from "./reporter.js";

export default defineEvalConfig({
  reporters: [evalLifecycleReporter],
});
