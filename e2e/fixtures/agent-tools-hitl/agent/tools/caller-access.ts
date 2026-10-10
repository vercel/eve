import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Check whether the executing caller has fixture release access.",
  inputSchema: z.object({}),
  approval: {
    request: always(),
    response: ({ response }) =>
      response.principal.principalId === "bob"
        ? { status: "allowed" }
        : { reason: "Only Bob may approve release-access checks.", status: "rejected" },
  },
  execute: (_input, ctx) => ({
    actor: ctx.session.auth.current?.principalId ?? "none",
    allowed: ctx.session.auth.current?.principalId === "bob",
  }),
});
