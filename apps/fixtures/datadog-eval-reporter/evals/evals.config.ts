import { defineEvalConfig } from "eve/evals";
import { Datadog } from "eve/evals/reporters";

export default defineEvalConfig({
  reporters: [
    Datadog({
      description: "Deterministic fixture coverage for the eve Datadog reporter.",
      projectName: "eve-datadog-eval-reporter",
      tags: { fixture: "datadog-eval-reporter" },
    }),
  ],
});
