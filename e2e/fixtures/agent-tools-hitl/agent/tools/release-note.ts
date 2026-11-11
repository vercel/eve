import { defineTool } from "eve/tools";
import { steered } from "eve/tools/approval";
import { z } from "zod";

/**
 * Posts the release note for the turn's caller. After someone else speaks, eve asks the caller
 * before it runs.
 */
export default defineTool({
  approval: steered(),
  description: "Post the release note for the person whose message started this turn.",
  inputSchema: z.object({}),
  execute: (_input, ctx) => ({
    postedFor: ctx.session.auth.current?.principalId ?? "none",
    sender: ctx.session.auth.sender?.principalId ?? "none",
  }),
});
