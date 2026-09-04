import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

/**
 * Parks the turn on a long durable sleep so a steer can cancel it. Exercises
 * cancellation cascading into a workflow tool run.
 */
export default defineWorkflowTool({
  description: "Hold a deploy open until cancelled.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }) {
    await sleep("10m");
    return { held: service };
  },
});
