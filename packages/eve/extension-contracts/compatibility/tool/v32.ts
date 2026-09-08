import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Read a report.",
  inputSchema: z.object({ report: z.string() }),
  label: { start: ({ report }) => `Read ${report}` },
  execute: ({ report }) => ({ report }),
});
