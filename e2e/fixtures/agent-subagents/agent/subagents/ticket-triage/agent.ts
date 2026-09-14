import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

import { createSoftwareFactoryStageModel } from "../../software-factory";

const config = e2eSubagentConfig();

const agent: ReturnType<typeof defineAgent> = defineAgent({
  description:
    "Software-factory ticket triage specialist. Give this agent a synthetic ticket batch to classify before review or reproduction planning.",
  ...config,
  model: createSoftwareFactoryStageModel("triage"),
  modelContextWindowTokens: 1_000_000,
  reasoning: "high",
});

export default agent;
