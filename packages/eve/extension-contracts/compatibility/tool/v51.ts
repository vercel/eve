import { defineTool } from "#public/tools/index.js";

export default defineTool({
  availableInSubagents: false,
  description: "Coordinate work only from a top-level root session.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute: () => ({ status: "ready" }),
});
