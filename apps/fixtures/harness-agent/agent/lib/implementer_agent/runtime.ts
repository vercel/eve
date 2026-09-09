import { createHarnessAgentWorkflowTool } from "../harness-agent-workflow";

export const tool = createHarnessAgentWorkflowTool({
  description: "Ask a coding expert to inspect and modify code to complete an implementation task.",
  instructions:
    "You are a coding expert. Inspect the relevant project files, implement the requested changes, and verify your work when practical.",
});
