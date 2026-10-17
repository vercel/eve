import { defineTool } from "eve/tools";
import { z } from "zod";
import { increment } from "../lib/counters.js";
export default defineTool({
  description: "Increment and return this session's invocation count.",
  inputSchema: z.strictObject({}),
  execute: (_input, ctx) => increment(ctx.session.id, "count"),
});
