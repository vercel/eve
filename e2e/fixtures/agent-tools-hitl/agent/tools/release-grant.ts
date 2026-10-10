import { defineTool, type ToolAuthProvider } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

/** A per-user credential: each person's token names them, so the result shows whose was used. */
const releaseAuth: ToolAuthProvider = {
  credentialOwner: "user",
  async getToken({ principal }) {
    return { token: `release-token:${principal.type === "user" ? principal.id : "app"}` };
  },
};

export default defineTool({
  description: "Grant release access with the approver's credentials, on the requester's behalf.",
  inputSchema: z.object({}),
  approval: {
    request: always(),
    response: ({ response }) =>
      response.principal.principalId === "bob" ? { status: "allowed" } : { status: "rejected" },
  },
  async execute(_input, ctx) {
    const requesterToken = await ctx.getToken(releaseAuth);
    const responderToken = await ctx.approval?.getToken(releaseAuth);
    return {
      requester: ctx.session.auth.current?.principalId ?? "none",
      requesterToken: requesterToken.token,
      responder: ctx.approval?.responder.principalId ?? "none",
      responderToken: responderToken?.token ?? "none",
    };
  },
});
