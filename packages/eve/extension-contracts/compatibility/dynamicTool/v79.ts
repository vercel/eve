import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 79 reached the v26 stream event types through client results; epoch 80 replaces
// them with v27 session events. Dynamic tools that don't read session events keep working.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => ({
      session: defineTool({
        deferred: true,
        description: "Return the active session identifier.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ sessionId: ctx.session.id }),
      }),
    }),
  },
});
