import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  executeGitHubShell,
  githubShellApproval,
  type GitHubConfig,
  type GitHubShellInput,
} from "./github-shell.ts";
import { githubShellInputSchema } from "./github-shell-schema.ts";

export const GH_TOOL_DESCRIPTION =
  "Run one authenticated gh, git, or gh-signed-commit command in the sandbox, without an approval prompt; the full gh CLI is available. Set description to the GitHub-side result the command should produce. Declare exactly one repository in the configured organization: the token covers only that repository, the sandbox sees only a placeholder GH_TOKEN, and commands that name another repository with -R, --repo, or a gh repo clone, view, or fork argument are denied. The command runs as argv without a shell, so send one command per call, with no pipes, &&, ;, redirects, heredocs, $(...) or $VARIABLE substitutions, or environment assignments. Filter output with --jq '<expr>', and pass Markdown bodies with --body-file <path>. Set the workingDirectory parameter for the directory; cd and git -C are refused. git supports only fetch, ls-remote, pull, and push against origin, such as git push origin <branch>; gh-signed-commit requires --repo; run local git commands such as status, diff, add, commit, and rebase in bash.";

const ghOutputSchema = z.object({
  exitCode: z.number().int(),
  stderr: z.string(),
  stdout: z.string(),
  truncated: z.boolean(),
});

/** The Connect-brokered `gh` tool, rebuilt by the dynamic resolver with its current config. */
export function defineGhTool(
  github: () => GitHubConfig | undefined,
  description = GH_TOOL_DESCRIPTION,
) {
  return defineTool({
    description,
    approval: ({ toolInput }) => githubShellApproval(toolInput as GitHubShellInput | undefined),
    inputSchema: githubShellInputSchema,
    outputSchema: ghOutputSchema,
    execute(input, ctx) {
      return executeGitHubShell(input, github(), {
        context: ctx,
        auth: ctx.session.auth.current,
        getSandbox: () => ctx.getSandbox(),
        sessionId: ctx.session.id,
      });
    },
  });
}
