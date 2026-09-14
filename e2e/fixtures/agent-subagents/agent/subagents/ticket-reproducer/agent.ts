import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

import { createSoftwareFactoryStageModel } from "../../software-factory";

const config = e2eSubagentConfig();

const agent: ReturnType<typeof defineAgent> = defineAgent({
  description:
    "Software-factory reproduction planner. Give this agent completed triage and review results to produce a concrete reproduction artifact.",
  ...config,
  model: createSoftwareFactoryStageModel("reproduce"),
  modelContextWindowTokens: 1_000_000,
  reasoning: "high",
});

export default agent;
