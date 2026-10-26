import { defineTool } from "eve/tools";
import { z } from "zod";

import { environment } from "../sandbox.js";

export default defineTool({
  description: "Checks the workspace for Alice's note.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox(environment);
    return {
      machine: sandbox.machineId(),
      note: await sandbox.readTextFile({ path: "note.txt" }),
      probe: await sandbox.readTextFile({ path: "probe.txt" }),
    };
  },
});
