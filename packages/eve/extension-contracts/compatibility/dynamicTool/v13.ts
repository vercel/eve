import { z as z3 } from "zod/v3";

import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      defineTool({
        description: "Report a namespaced status for the active session.",
        inputSchema: z3.object({ prefix: z3.string() }),
        execute: ({ prefix }) => ({ status: `${prefix}:${ctx.session.id}` }),
      }),
  },
});
