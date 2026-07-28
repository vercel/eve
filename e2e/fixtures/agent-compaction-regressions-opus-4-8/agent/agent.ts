import { createCompactionRegressionAgent } from "@eve/e2e-compaction-regression-shared/agent";
import type { AgentDefinition } from "eve";

const agent: AgentDefinition = createCompactionRegressionAgent({
  compactionModel: "anthropic/claude-opus-4.8",
  modelFamily: "opus-4.8",
});

export default agent;
