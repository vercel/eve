import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 80 had no `history` option or `history.imported` event; epoch 81 adds both, which is additive.
export default defineTool({
  description: "Report the authenticated caller.",
  inputSchema: z.object({}),
  outputSchema: z.object({ principalId: z.string().nullable() }),
  execute: (_input, ctx) => ({ principalId: ctx.session.auth.current?.principalId ?? null }),
});
