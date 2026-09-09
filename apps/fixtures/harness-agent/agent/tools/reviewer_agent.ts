import { defineWorkflowTool } from "eve/tools";

import { createHarnessAgentWorkflowToolDefinition } from "../lib/harness-agent-workflow-tool-definition";
import { settings } from "../lib/reviewer_agent/settings";
import { reviewerWorkflow } from "../lib/reviewer_agent/workflow";

export default defineWorkflowTool({
  ...createHarnessAgentWorkflowToolDefinition({
    description: "Ask a code reviewer to review code and return a structured verdict.",
    settings,
  }),
  execute: reviewerWorkflow,
});
