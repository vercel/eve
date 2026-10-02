import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 73 MCP connection definitions had no `forwardPrincipal`; epoch 74 adds it.
// Tools that read the session caller keep working.
export default defineTool({
  description: "Report which account a lookup runs as.",
  inputSchema: z.object({}),
  outputSchema: z.object({ principalId: z.string().nullable() }),
  execute: (_input, ctx) => ({ principalId: ctx.session.auth.current?.principalId ?? null }),
});
