import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineTool({
        description: "Return the current status.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ status: "ready" }),
      }),
  },
});
