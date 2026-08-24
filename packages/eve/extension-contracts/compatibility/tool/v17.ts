import { z as z3 } from "zod/v3";

import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Read the active session id.",
  inputSchema: z3.object({ prefix: z3.string() }),
  execute: ({ prefix }, ctx) => ({ sessionId: `${prefix}:${ctx.session.id}` }),
});
