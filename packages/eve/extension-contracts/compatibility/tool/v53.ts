import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Read the active session before registry APIs were added.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute(_input, ctx) {
    return { sessionId: ctx.session.id, callId: ctx.callId };
  },
});
