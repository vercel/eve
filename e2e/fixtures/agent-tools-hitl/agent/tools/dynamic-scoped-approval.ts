import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { once } from "eve/tools/approval";

export default defineDynamic({
  events: {
    "session.started": () => ({
      dynamic_scoped_approval: defineTool({
        description:
          "Echoes a scope after approving that scope. Only call when explicitly asked for dynamic_scoped_approval.",
        inputSchema: z.object({ scope: z.string() }),
        approval: once({ key: (input) => input.scope }),
        execute: (input) => ({ scope: input.scope }),
      }),
    }),
  },
});
