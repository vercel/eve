import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

import { stageDeploy } from "../../../lib/stage.ts";

/** The child's own staging task; subagents do not inherit the root's tools. */
export default defineWorkflowTool({
  description: "Stage a service deploy and report its plan digest.",
  inputSchema: z.strictObject({ service: z.string() }),
  async task({ service }) {
    "use workflow";

    return await stageDeploy(service);
  },
});
