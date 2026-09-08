import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

import { deployService } from "../lib/deploy.ts";

/**
 * Waiting workflow tool: the turn parks while the run hashes the plan and
 * sleeps, then resumes with the return value as the tool result.
 */
export default defineWorkflowTool({
  description: "Deploy a service after planning it durably.",
  inputSchema: z.strictObject({ service: z.string() }),
  execute: deployService,
});
