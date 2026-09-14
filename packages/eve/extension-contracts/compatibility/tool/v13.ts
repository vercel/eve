import { z as z3 } from "zod/v3";

import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Look up a report.",
  inputSchema: z3.object({ reportId: z3.string() }),
  execute(input, ctx) {
    return { callId: ctx.callId, reportId: input.reportId };
  },
});
