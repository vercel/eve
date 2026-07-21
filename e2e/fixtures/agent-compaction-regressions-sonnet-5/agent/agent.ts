import { createCompactionRegressionAgent } from "@eve/e2e-compaction-regression-shared/agent";
import type { AgentDefinition } from "eve";

const agent: AgentDefinition = createCompactionRegressionAgent({
  compactionModel: "anthropic/claude-sonnet-5",
  modelFamily: "sonnet-5",
});

export default agent;
