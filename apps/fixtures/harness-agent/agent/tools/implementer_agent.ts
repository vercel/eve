import { defineWorkflowTool } from "eve/tools";

import { tool } from "../lib/implementer_agent/runtime";
import { implementerWorkflow } from "../lib/implementer_agent/workflow";

export default defineWorkflowTool({
  ...tool.definition,
  execute: implementerWorkflow,
});
