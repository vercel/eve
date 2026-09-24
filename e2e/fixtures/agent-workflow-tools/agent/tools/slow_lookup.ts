import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

/**
 * Waited lookup that takes `seconds` to answer. A steering message in an
 * interactive session moves it to the background.
 */
export default defineWorkflowTool({
  description: "Look up the status of one system. Takes the given number of seconds.",
  inputSchema: z.strictObject({ topic: z.string(), seconds: z.number().int().min(0).max(120) }),
  async execute({ topic, seconds }) {
    "use workflow";

    if (seconds > 0) await sleep(`${seconds}s`);
    return { status: "green", topic };
  },
});
