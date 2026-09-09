import { defineWorkflowTool } from "eve/tools";

import { createHarnessAgentWorkflowToolDefinition } from "../lib/harness-agent-workflow-tool-definition";
import { settings } from "../lib/implementer_agent/settings";
import { implementerWorkflow } from "../lib/implementer_agent/workflow";

export default defineWorkflowTool({
  ...createHarnessAgentWorkflowToolDefinition({
    description:
      "Ask a coding expert to inspect and modify code to complete an implementation task.",
    settings,
  }),
  execute: implementerWorkflow,
});
