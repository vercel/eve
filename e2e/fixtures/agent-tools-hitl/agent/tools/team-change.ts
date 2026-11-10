import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

/** A change the team asks the caller about whenever someone else is involved. */
export default defineTool({
  description: "Make the team-only change.",
  inputSchema: z.object({}),
  approval: always({ when: "principal-mismatch" }),
  execute: (_input, ctx) => ({ actor: ctx.session.auth.current?.principalId ?? "none" }),
});
