import { z } from "zod";

import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Start a report.",
  execution: "background",
  inputSchema: z.object({ reportId: z.string() }),
  execute(input, _ctx, task) {
    void Promise.resolve().then(() =>
      task.send({ data: { reportId: input.reportId }, kind: "complete" }),
    );
    return task.delegated({
      executor: { data: { reportId: input.reportId }, kind: "report" },
      receipt: { reportId: input.reportId },
    });
  },
});
