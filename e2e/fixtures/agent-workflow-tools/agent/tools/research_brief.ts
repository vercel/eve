import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

import { markHelperOpened, waitForParentGenerating } from "../lib/helper-opened.ts";

/**
 * A task whose run opens a helper agent while the parent's next model step is
 * generating, then waits a few seconds before it settles. The helper's
 * `agent.started` arrives mid-step, and its hooks must still keep their
 * writes. The sleep only keeps the turn held: the session admits a task's
 * result after each model step, so the task must still be working when that
 * step ends for its interim reply to come first.
 */
export default defineWorkflowTool({
  description: "Research a topic in the background with a helper agent and report its findings.",
  inputSchema: z.strictObject({ topic: z.string() }),
  async task({ topic }, ctx) {
    "use workflow";

    await waitForParentGenerating(ctx.callId);
    // `send` returns once the helper's session opened and announced itself.
    const helper = await ctx.agent("workflow-marker").send(topic);
    await markHelperOpened(ctx.callId);
    const result = await helper.result();
    if (result.status === "failed") throw new Error('Agent "workflow-marker" failed.');
    await sleep("3s");
    return result.message ?? null;
  },
});
