import { defineEvalConfig } from "eve/evals";
import { Datadog } from "eve/evals/reporters";

export default defineEvalConfig({
  reporters: [Datadog({ recordInputs: true })],
});
