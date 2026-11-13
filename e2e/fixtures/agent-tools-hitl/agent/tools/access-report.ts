import { isConnectionAuthorizationFailedError } from "eve/connections";
import { defineTool, type ToolAuthProvider } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

/** A per-user credential, so only the turn's caller can resolve a token for it. */
const provider: ToolAuthProvider = {
  principalType: "user",
  getToken: async ({ principal }) => ({
    token: `fixture-token-${principal.type === "user" ? principal.id : "app"}`,
  }),
};

export default defineTool({
  description: "Report the caller, who steered the turn, and whether the caller's token works.",
  inputSchema: z.object({}),
  approval: never(),
  async execute(_input, ctx) {
    let access: string;
    try {
      await ctx.getToken(provider);
      access = "granted";
    } catch (error) {
      if (!isConnectionAuthorizationFailedError(error)) throw error;
      access = error.reason ?? "failed";
    }
    return {
      caller: ctx.session.auth.current?.principalId ?? null,
      steeredBy: ctx.session.auth.steeredBy?.map((person) => person.principalId) ?? [],
      access,
    };
  },
});
