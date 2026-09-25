import { z as z3 } from "zod/v3";

import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Start a report.",
  execution: "background",
  inputSchema: z3.object({ reportId: z3.string() }),
  execute(input, _ctx, task) {
    return task.delegated({
      executor: { data: { reportId: input.reportId }, kind: "report" },
      receipt: { reportId: input.reportId },
    });
  },
});
