import { defineTool } from "eve/tools";
import { z } from "zod";
import { REPO_DIR, validateBranch } from "../../../lib/github/git-remote.js";
import { fetchRepository } from "../../../lib/github/git-transfer.js";
import { environment } from "../sandbox.js";

/** Fetches through an isolated transfer sandbox; the station receives only Git objects. */
export default defineTool({
  description: `Fetch the branch under review from the factory repository and check it out in ${REPO_DIR}. Run this first, then read the real diff against the base branch.`,
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
      .describe("The pushed branch to fetch and check out for review."),
  }),
});
