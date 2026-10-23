import { defineWorkflowTool, type WorkflowStepToolContext } from "eve/tools";
import { z } from "zod";

import { environment } from "../sandbox.js";

export default defineWorkflowTool({
  description: "Prepares the note in a workflow step.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    "use workflow";
    return await prepareNote(ctx);
  },
});

async function prepareNote(ctx: WorkflowStepToolContext) {
  "use step";
  // The session has not opened its sandbox yet, so the step creates it under the session's id.
  // The step imports its own copy of the environment the session's sandbox uses.
  const sandbox = await ctx.getSandbox(environment);
  // Writing the whole file keeps a retried step's write the same.
  await sandbox.writeTextFile({
    content: "step-sandbox-note-ok-H3R:prepared-in-step",
    path: "step-note.txt",
  });
  return "prepared";
}
