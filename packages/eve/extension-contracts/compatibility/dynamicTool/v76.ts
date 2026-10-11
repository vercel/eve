import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 76 skill loads named their skill only in the action's `input`, and a
// `load-skill-result` might omit `name`; epoch 77 adds `name` to `load-skill`
// requests and requires it on results. Dynamic tools don't read skill loads.
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
