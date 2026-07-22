import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Return an internal result with a model-facing summary",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    return { internal: true, summary: "Operation completed" };
  },
  toModelOutput(output) {
    return { type: "text", value: output.summary };
  },
});
