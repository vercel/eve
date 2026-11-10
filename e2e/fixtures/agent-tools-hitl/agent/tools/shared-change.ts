import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

/** A change the caller approves once for each mix of caller, sender, and initiator. */
export default defineTool({
  description: "Make the shared change.",
  inputSchema: z.object({}),
  approval: once({ when: "principal-mismatch" }),
  execute: (_input, ctx) => ({ actor: ctx.session.auth.current?.principalId ?? "none" }),
});
