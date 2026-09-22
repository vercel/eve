import { z } from "zod";

import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Start a durable report task.",
  execution: "background",
  inputSchema: z.object({ reportId: z.string() }),
  execute(input, _ctx, task) {
    return task.delegated({
      executor: { data: { reportId: input.reportId }, kind: "report" },
      receipt: { reportId: input.reportId },
    });
  },
});
