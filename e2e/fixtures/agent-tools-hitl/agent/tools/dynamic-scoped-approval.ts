import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

export default defineDynamic({
  events: {
    "session.started": () => ({
      dynamic_scoped_approval: defineTool({
        description:
          "Echoes a scope after approving that scope. Only call when explicitly asked for dynamic_scoped_approval.",
        inputSchema: z.object({ scope: z.string() }),
        approvalKey: (input) => `dynamic_scoped_approval:${input.scope}`,
        approval: ({ approvedTools, toolInput }) =>
          approvedTools.has(`dynamic_scoped_approval:${toolInput?.scope}`)
            ? "not-applicable"
            : "user-approval",
        execute: (input) => ({ scope: input.scope }),
      }),
    }),
  },
});
