import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { releaseAuth } from "../lib/hitl/release-auth.ts";

export default defineTool({
  description: "Grant release access with the approver's credentials, on the requester's behalf.",
  inputSchema: z.object({}),
  approval: {
    request: always(),
    response: ({ response }) =>
      response.principal.principalId === "bob"
        ? { status: "allowed" }
        : { status: "rejected", reason: "Only bob can approve this fixture." },
  },
  async execute(_input, ctx) {
    const requesterToken = await ctx.getToken(releaseAuth);
    const responderToken = await ctx.approval?.responder.getToken(releaseAuth);
    return {
      requester: ctx.session.auth.current?.principalId ?? "none",
      requesterToken: requesterToken.token,
      responder: ctx.approval?.responder.principalId ?? "none",
      responderToken: responderToken?.token ?? "none",
    };
  },
});
