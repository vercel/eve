import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

/**
 * A resumable workflow tool: each call with the task's `taskId` sends the
 * body a revision request, which it reads with `ctx.receive()` and answers
 * with one `ctx.reply()`. A `done` request ends the task.
 */
export default defineWorkflowTool({
  description: "Draft a short note on a topic, then revise it on request.",
  inputSchema: z.strictObject({ request: z.string().min(1).max(200) }),
  resumable: true,
  async execute(input, ctx): Promise<string | undefined> {
    "use workflow";

    let revision = 0;
    let { request } = input;
    for (;;) {
      // Each piece of work takes a moment, so a task_wait the model calls
      // right after the receipt receives its result.
      await sleep("2s");
      if (request === "done") return "Closed the notes.";
      revision += 1;
      ctx.reply(`Draft ${revision}: ${request}`);
      ({ request } = await ctx.receive());
    }
  },
});
