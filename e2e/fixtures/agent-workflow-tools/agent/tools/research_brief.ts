import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

import { replyFrom } from "../lib/agent-reply.ts";

/**
 * A task whose run opens a helper agent, then waits a few seconds before it
 * settles. The helper's `agent.started` hooks keep their writes whether it
 * opens during a model step or between steps. The sleep only keeps the turn
 * held: the session admits a task's result after each model step, so the task
 * must still be working when the step that started it ends for the model's
 * next step to write its interim reply first.
 */
export default defineWorkflowTool({
  description: "Research a topic in the background with a helper agent and report its findings.",
  inputSchema: z.strictObject({ topic: z.string() }),
  async task({ topic }, ctx) {
    "use workflow";

    const findings = await replyFrom(ctx, "workflow-marker", topic);
    await sleep("3s");
    return findings;
  },
});
