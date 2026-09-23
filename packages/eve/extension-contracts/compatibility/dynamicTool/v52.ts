import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 52 tool contexts also exposed getSkill(); the remaining members are unchanged.
export default defineDynamic({
  events: {
    "session.started": () => ({
      session_id: defineTool({
        description: "Return the current session id.",
        inputSchema: { type: "object", properties: {} },
        execute: (_input, ctx) => ctx.session.id,
      }),
    }),
  },
});
