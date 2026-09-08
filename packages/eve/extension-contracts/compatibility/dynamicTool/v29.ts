import { z } from "zod";
import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineTool({
        description: "Read a report.",
        inputSchema: z.object({ report: z.string() }),
        execute: ({ report }) => ({ report }),
      }),
  },
});
