import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

import { releaseAuth } from "../lib/hitl/release-auth.ts";

const onMismatch = once({ when: "principal-mismatch" });

/**
 * The documented actor pattern: the model names whose request the change carries out. For the
 * caller it asks only on a mismatch; for anyone else it asks that person and runs with their token.
 */
export default defineTool({
  description:
    "Ship one change. Set actor to the principal id of the person whose request it carries out.",
  inputSchema: z.object({ actor: z.string() }),
  approval: {
    request: (ctx) =>
      ctx.toolInput?.actor === ctx.session.auth.current?.principalId
        ? onMismatch(ctx)
        : "user-approval",
    response: ({ request, response }) => {
      if (response.decision === "deny") return { status: "allowed" };
      return response.principal.principalId === request.toolInput?.actor
        ? { status: "allowed" }
        : { status: "rejected", reason: "Only the person this change is for can approve it." };
    },
  },
  async execute(_input, ctx) {
    const approver = ctx.approval?.responder;
    const { token } = await (approver ?? ctx).getToken(releaseAuth);
    return {
      actor: approver?.principalId ?? ctx.session.auth.current?.principalId ?? "none",
      token,
    };
  },
});
