import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubCredentials } from "../../../lib/github/credentials.js";
import {
  brokerPolicy,
  mintInstallationToken,
  REMOTE_URL,
  REPO_DIR,
  validateBranch,
} from "../../../lib/github/git-remote.js";
import { environment } from "../sandbox.js";

/**
 * Pushes a committed feature branch of the sandbox checkout to the factory
 * repository.
 *
 * @remarks
 * The command accepts feature branch names and disables repository hooks.
 * The credential is brokered at the sandbox firewall and never enters the
 * sandbox, and the push targets {@link REMOTE_URL} literally, never the
 * model-writable `origin` remote. The `finally` block drops the brokered
 * credential again. Server-side branch protection remains required: other
 * sandbox processes can use the brokered credential while this push runs.
 */
export default defineTool({
  description: `Push a local branch of the ${REPO_DIR} checkout to the factory repository. The branch must already exist locally with the work committed and the checks run; main and master are refused. After a successful push, report the branch name in your structured output so the orchestrator can open the pull request.`,
  async execute(input, ctx) {
    const refusal = validateBranch(input.branch);
    if (refusal) {
      return { error: refusal, success: false as const };
    }
    const sandbox = await ctx.getSandbox(environment);
    const token = await mintInstallationToken(githubCredentials);
    await sandbox.setNetworkPolicy(brokerPolicy(token));
    try {
      const push = await sandbox.run({
        command: `git -c core.hooksPath=/dev/null -C ${REPO_DIR} push --no-verify ${REMOTE_URL} 'refs/heads/${input.branch}:refs/heads/${input.branch}'`,
      });
      if (push.exitCode !== 0) {
        return {
          error: `git push exited ${push.exitCode}: ${String(
            push.stderr || push.stdout
          ).trim()}`,
          success: false as const,
        };
      }
      const head = await sandbox.run({
        command: `git -C ${REPO_DIR} rev-parse '${input.branch}'`,
      });
      return {
        branch: input.branch,
        sha: String(head.stdout).trim(),
        success: true as const,
      };
    } finally {
      await sandbox.setNetworkPolicy("allow-all");
    }
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
