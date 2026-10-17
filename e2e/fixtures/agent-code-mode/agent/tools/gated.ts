import { increment } from "../lib/counters.js";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
export default defineTool({
  approval: always(),
  description: "An approval-gated side effect.",
  inputSchema: z.strictObject({}),
  execute: (_input, ctx) => {
    increment(ctx.session.id, "gated");
    return "approved";
  },
});
