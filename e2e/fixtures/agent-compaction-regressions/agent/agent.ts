import { createCompactionRegressionAgent } from "@eve/e2e-compaction-regression-shared/agent";
import type { AgentDefinition } from "eve";

const agent: AgentDefinition = createCompactionRegressionAgent({
  compactionModel: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol",
});

export default agent;
