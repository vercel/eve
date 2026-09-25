import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Start a durable background export.",
  execution: "background",
  inputSchema: z.strictObject({ query: z.string() }),
  async *execute({ query }) {
    "use workflow";

    yield { progress: 0.5 };
    yield { message: "EXPORT-PROGRESS", progress: 0.75 };
    await sleep("250ms");
    return { query, result: "EXPORT-COMPLETE" };
  },
});
