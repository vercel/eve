import { defineTool } from "eve/tools";
import { z } from "zod";
import { counters, increment } from "../lib/counters.js";
export default defineTool({
  description: "Read per-tool invocation counters persisted across worker restarts.",
  inputSchema: z.strictObject({}),
  execute: (_input, ctx) => {
    increment(ctx.session.id, "counters");
    return counters(ctx.session.id);
  },
});
