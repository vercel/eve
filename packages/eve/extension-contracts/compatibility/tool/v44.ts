import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Read the current session identity.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute(_input, ctx) {
    return { sessionId: ctx.session.id };
  },
});
