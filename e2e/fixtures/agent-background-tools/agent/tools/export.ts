import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Start a durable background export.",
  execution: "background",
  inputSchema: z.strictObject({ query: z.string() }),
  async *execute({ query }, _ctx, task) {
    "use workflow";

    yield { progress: 0.5 };
    yield task.postMessage(`Export ${task.taskId}: EXPORT-PROGRESS`);
    await sleep("250ms");
    return { query, result: "EXPORT-COMPLETE" };
  },
});
