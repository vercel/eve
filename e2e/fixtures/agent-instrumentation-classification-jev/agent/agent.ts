import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";
import { mockModel } from "eve/evals";

import { classificationProbe } from "./testing";

const { experimental } = e2eAgentConfig();
const model = mockModel({
  modelId: "instrumentation-classification-fixture",
  respond: () => JSON.stringify({ classification: classificationProbe.get() }),
});

export default defineAgent({
  experimental,
  model: defineDynamic({
    events: {
      "step.started": () => ({
        model,
        modelContextWindowTokens: 1_000_000,
      }),
    },
  }),
});
