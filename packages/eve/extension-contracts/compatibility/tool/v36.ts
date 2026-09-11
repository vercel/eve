import { z } from "zod";

import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Report the active session.",
  inputSchema: z.object({}),
  outputSchema: z.object({ sessionId: z.string() }),
  execute: (_input, ctx) => ({ sessionId: ctx.session.id }),
});
