import { defineTool } from "eve/tools";
import { z } from "zod";
import { REPO_DIR, validateBranch } from "../../../lib/github/git-remote.js";
import { fetchRepository } from "../../../lib/github/git-transfer.js";
import { environment } from "../sandbox.js";

/** Fetches through an isolated transfer sandbox; the station receives only Git objects. */
export default defineTool({
  description: `Fetch an existing branch of the factory repository and check it out in ${REPO_DIR}. Use this on a revision run, when the reviewer's findings name a branch that already exists; fresh work starts from the default branch with plain git instead.`,
  async execute(input, ctx) {
    const refusal = validateBranch(input.branch);
    if (refusal) {
      return { error: refusal, success: false as const };
    }
    const sandbox = await ctx.getSandbox(environment);
    const sha = await fetchRepository(sandbox, input.branch);
    return { branch: input.branch, sha, success: true as const };
  },
  inputSchema: z.object({
    branch: z
      .string()
      .min(1)
      .describe("The existing branch to fetch and check out."),
  }),
});
