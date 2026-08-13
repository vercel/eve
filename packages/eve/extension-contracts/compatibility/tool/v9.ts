import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Look up a report.",
  inputSchema: {
    type: "object",
    properties: { reportId: { type: "string" } },
    required: ["reportId"],
  },
  execute(input) {
    return { reportId: input.reportId };
  },
});
