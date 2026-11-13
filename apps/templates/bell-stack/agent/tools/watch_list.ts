import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { monitors } from "../../server/monitors/service";
import { watchIdentity, safeWatch } from "../lib/monitors";

export default defineTool({
  description: "List this sender's watches, recent updates, and pending failures. Use this to reconcile uncertain creation before making another watch, or to find the ID of a watch to update or stop. Returns one page of 50 watches, open ones (still running or still needing repair) before cancelled and failed ones, newest first within each. When next_cursor is not null there are older watches: call again with that value as cursor to read the next page.",
  inputSchema: z.object({
    status: z.enum(["all", "open", "closed"]).default("all").describe("Which watches to return: all, only open ones (not cancelled or failed), or only closed ones."),
    cursor: z.string().max(512).optional().describe("The next_cursor from a previous watch_list call, to read the next page of older watches."),
  }),
  execute: (input, ctx) => safeWatch(() => monitors().list(watchIdentity(ctx), { status: input.status, cursor: input.cursor })),
  toModelOutput: output => toolOutput.json(output),
});
