import { defineWorkflowTool } from "eve/tools";

import { tool } from "../lib/reviewer_agent/runtime";
import { reviewerWorkflow } from "../lib/reviewer_agent/workflow";

export default defineWorkflowTool({
  ...tool.definition,
  execute: reviewerWorkflow,
});
