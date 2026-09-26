import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

import { stageDeploy } from "../lib/stage.ts";

/** A task: the model gets a receipt at once, and the staged plan arrives as its result. */
export default defineWorkflowTool({
  description: "Stage a service deploy and report its plan digest.",
  inputSchema: z.strictObject({ service: z.string() }),
  async task({ service }) {
    "use workflow";

    return await stageDeploy(service);
  },
});
