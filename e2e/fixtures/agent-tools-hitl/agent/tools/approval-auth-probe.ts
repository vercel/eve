import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

const auth = {
  async getToken() {
    return { token: "approval-resume-token-T8K2" };
  },
};

export default defineTool({
  description:
    "Approval-gated token probe. Call only when explicitly asked to verify auth after approval.",
  inputSchema: z.object({ marker: z.string() }),
  approval: once(),
  async execute(input, ctx) {
    const token = await ctx.getToken(auth, { authKey: "approval-resume-probe" });
    return { marker: input.marker, token: token.token };
  },
});
