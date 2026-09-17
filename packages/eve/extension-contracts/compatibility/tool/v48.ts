import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Report a guarded value.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  approval({ callId, toolInput, toolName }) {
    return callId && toolName && toolInput?.value ? "user-approval" : "denied";
  },
  execute({ value }) {
    return value;
  },
});
