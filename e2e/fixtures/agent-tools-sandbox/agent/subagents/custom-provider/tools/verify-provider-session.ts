import { defineTool } from "eve/tools";
import { z } from "zod";

import { CUSTOM_WORKSPACE_ROOT } from "../sandbox.js";

export default defineTool({
  description:
    "Reads the session marker and leaves Bob a checklist in the custom provider's workspace.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    const checklist = "Bob, the checklist is ready.";
    await sandbox.writeTextFile({ content: checklist, path: "handoff/checklist.txt" });
    return {
      checklist: await sandbox.readTextFile({ path: "handoff/checklist.txt" }),
      checklistAtRoot: await sandbox.readTextFile({
        path: `${CUSTOM_WORKSPACE_ROOT}/handoff/checklist.txt`,
      }),
      probe: await sandbox.readTextFile({ path: `${CUSTOM_WORKSPACE_ROOT}/probe.txt` }),
      root: sandbox.resolvePath("."),
    };
  },
});
