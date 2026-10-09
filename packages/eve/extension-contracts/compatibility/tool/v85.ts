import { defineTool } from "#public/tools/index.js";

// Epoch 85 approval policies that decide without tool annotations remain supported.
export default defineTool({
  approval: ({ toolInput }) => (toolInput?.force === true ? "user-approval" : "not-applicable"),
  description: "Restart the service, asking first when forced.",
  inputSchema: {
    type: "object",
    properties: { force: { type: "boolean" } },
    additionalProperties: false,
  },
  execute: () => ({ restarted: true }),
});
