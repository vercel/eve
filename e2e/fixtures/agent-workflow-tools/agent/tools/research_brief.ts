import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

/**
 * A task whose run opens a helper agent right away, then waits a few seconds
 * before it settles. The parent's next model step is slow, so the helper
 * usually opens while that step runs. The sleep keeps the task working when
 * that step starts, so the step writes its interim reply instead of the
 * task's result and the turn is held.
 */
export default defineWorkflowTool({
  description: "Research a topic in the background with a helper agent and report its findings.",
  inputSchema: z.strictObject({ topic: z.string() }),
  async task({ topic }, ctx) {
    "use workflow";

    const helper = await ctx.agent("workflow-marker").send(topic);
    const result = await helper.result();
    if (result.status === "failed") throw new Error('Agent "workflow-marker" failed.');
    await sleep("3s");
    return result.message ?? null;
  },
});
