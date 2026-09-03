import { z } from "zod";

import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineTool({
        description: "Delegate a background report.",
        execution: "background",
        inputSchema: z.object({ reportId: z.string() }),
        execute({ reportId }, _ctx, task) {
          return task.delegated({
            executor: { data: { reportId }, kind: "report" },
            receipt: { reportId },
          });
        },
      }),
  },
});
