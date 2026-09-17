import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineTool({
        description: "Report the current session identity.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: () => ({ sessionId: ctx.session.id }),
      }),
  },
});
