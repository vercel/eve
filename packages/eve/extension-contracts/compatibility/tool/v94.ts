import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Identify the report's session.",
  inputSchema: {},
  execute(_input, ctx) {
    return { sessionId: ctx.session.id };
  },
});
