import { defineTool } from "eve/tools";
import { z } from "zod";
import { REPO_DIR, validateBranch } from "../../../lib/github/git-remote.js";
import { pushBranch } from "../../../lib/github/git-transfer.js";
import { environment } from "../sandbox.js";

/** Pushes one factory ref through an isolated bare repository, never the station's Git config. */
export default defineTool({
  description: `Push a local branch of the ${REPO_DIR} checkout to the factory repository. The branch must already exist locally with the work committed and the checks run; main and master are refused. After a successful push, report the branch name in your structured output so the orchestrator can open the pull request.`,
  async execute(input, ctx) {
    const refusal = validateBranch(input.branch);
    if (refusal) {
      return { error: refusal, success: false as const };
    }
    const sandbox = await ctx.getSandbox(environment);
    const sha = await pushBranch(sandbox, input.branch);
    return { branch: input.branch, sha, success: true as const };
  },
  inputSchema: z.object({
    branch: z
      .string()
      .min(1)
      .describe(
        "Branch name in /workspace/repo to push, e.g. factory/bug-dedupe-reset-emails"
      ),
  }),
});
