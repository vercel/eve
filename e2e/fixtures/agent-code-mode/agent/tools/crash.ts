import { isMainThread } from "node:worker_threads";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { increment } from "../lib/counters.js";
export default defineTool({
  description: "Test-only side effect followed by an abrupt local worker crash.",
  inputSchema: z.strictObject({}),
  execute: (_input, ctx) => {
    if (isMainThread || !process.env.EVE_DEV_WORKER_APP_ROOT)
      throw new Error("Crash fixture is only available in a local development worker.");
    increment(ctx.session.id, "crash");
    process.exit(1);
  },
});
