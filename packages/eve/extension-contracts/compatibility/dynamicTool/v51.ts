import { defineDurableCallback, defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": (_event, context) => ({
      session_id: defineTool({
        description: "Return the captured session id.",
        inputSchema: { type: "object", properties: {} },
        execute: defineDurableCallback({
          closure: { sessionId: context.session.id },
          callback: ({ sessionId }) => sessionId,
        }),
      }),
    }),
  },
});
