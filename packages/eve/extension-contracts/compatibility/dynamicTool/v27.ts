import { z } from "zod";

import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineTool({
        description: "Delegate a background report.",
        execution: "background",
        inputSchema: z.object({ reportId: z.string() }),
        async *execute({ reportId }, _ctx, task) {
          yield task.setState({ reportId });
          return { reportId };
        },
      }),
  },
});
