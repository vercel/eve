import { defineTool } from "eve/tools";
import { z } from "zod";

/** Who the turn runs as, and who spoke last in it. */
export default defineTool({
  description: "Report the turn's caller and the person who spoke last in it.",
  inputSchema: z.object({}),
  execute: (_input, ctx) => ({
    caller: ctx.session.auth.current?.principalId ?? "none",
    sender: ctx.session.auth.sender?.principalId ?? "none",
  }),
});
