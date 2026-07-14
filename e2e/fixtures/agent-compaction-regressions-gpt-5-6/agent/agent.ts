import { createCompactionRegressionAgent } from "@eve/e2e-compaction-regression-shared/agent";
import type { AgentDefinition } from "eve";

const agent: AgentDefinition = createCompactionRegressionAgent({
  compactionModel: "openai/gpt-5.6-sol",
  modelFamily: "gpt-5.6",
});

export default agent;
