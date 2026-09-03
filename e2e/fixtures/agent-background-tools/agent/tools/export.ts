import { defineTool } from "eve/tools";
import { sleep } from "eve/workflow";
import { z } from "zod";

export default defineTool({
  description: "Start a durable background export.",
  execution: "background",
  inputSchema: z.strictObject({ query: z.string() }),
  async *execute({ query }, _ctx, task) {
    "use workflow";

    yield task.setState({ query, phase: "exporting" });
    yield { progress: 0.5 };
    yield task.postMessage(`Export ${task.taskId}: EXPORT-PROGRESS`);
    await sleep("250ms");
    yield task.setState({ query, phase: "complete" });
    return { query, result: "EXPORT-COMPLETE" };
  },
});
