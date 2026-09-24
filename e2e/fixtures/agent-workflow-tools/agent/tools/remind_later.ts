import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

/**
 * Reminds the user after a delay. Each call starts a detached task, and the
 * reminder arrives later as a task result.
 */
export default defineWorkflowTool({
  description: "Remind the user about a note after the given number of seconds.",
  inputSchema: z.strictObject({ note: z.string(), seconds: z.number().int().min(1).max(300) }),
  async execute({ note, seconds }) {
    "use workflow";

    await sleep(`${seconds}s`);
    return { reminder: note };
  },
  toModelOutput(output) {
    return { type: "text", value: `Reminder: ${output.reminder}` };
  },
});
