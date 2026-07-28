import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "step.started": () => ({
      summarize_result: defineTool({
        description: "Return an internal result with a model-facing summary",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          return { internal: true, summary: "Operation completed" };
        },
        toModelOutput(output) {
          return { type: "text", value: output.summary };
        },
      }),
    }),
  },
});
