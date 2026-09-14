import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

import { createSoftwareFactoryStageModel } from "../../software-factory";

const config = e2eSubagentConfig();

const agent: ReturnType<typeof defineAgent> = defineAgent({
  description:
    "Software-factory backlog reviewer. Give this agent a synthetic ticket batch to produce an independent review summary before reproduction planning.",
  ...config,
  model: createSoftwareFactoryStageModel("review"),
  modelContextWindowTokens: 1_000_000,
  reasoning: "high",
});

export default agent;
