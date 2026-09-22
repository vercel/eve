import { defineDurableCallback, defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": (_event, context) => ({
      guarded: defineTool({
        description: "Return a captured value after approval.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        approval: defineDurableCallback({
          closure: { sessionId: context.session.id },
          callback: ({ sessionId }, { toolInput }) =>
            sessionId && toolInput?.value ? "user-approval" : "denied",
        }),
        execute: defineDurableCallback({
          closure: { sessionId: context.session.id },
          callback: ({ sessionId }, { value }) => ({ sessionId, value }),
        }),
      }),
    }),
  },
});
