import { defineTool } from "eve/tools";
import { z } from "zod";

import { environment } from "../sandbox.js";

export default defineTool({
  description: "Leaves Alice's note in the workspace, then lets the host retire her machine.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox(environment);
    await sandbox.writeTextFile({ content: "Bob, the report is ready.", path: "note.txt" });
    const machine = sandbox.machineId();
    await sandbox.retireForMaintenance();
    return { machine };
  },
});
