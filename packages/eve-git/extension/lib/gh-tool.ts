import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  executeGitHubShell,
  githubShellApproval,
  type GitHubConfig,
  type GitHubShellInput,
} from "./github-shell.ts";
import { githubShellInputSchema } from "./github-shell-schema.ts";

const GH_TOOL_SCOPE = {
  repository:
    "Connect mints a GitHub App installation token for that repository, or for the owner's installation when repository is an owner.",
  caller:
    "Connect resolves the caller's own GitHub token, which carries the caller's GitHub permissions, so GitHub allows whatever the caller can access.",
} as const;

/** Describes the `gh` tool for app-installation (`repository`) or user-scoped (`caller`) tokens. */
export function ghToolDescription(scope: keyof typeof GH_TOOL_SCOPE): string {
  return `Run one authenticated gh, git, or gh-signed-commit command in the sandbox. The full gh and git CLI surface is available. Set repository to the owner/name the command acts on, or to an owner for discovery such as gh repo list <owner> or gh search repos --owner <owner>${scope === "caller" ? "; omit it for commands tied to no owner, such as gh api user/repos" : ""}. The agent's access policy decides whether each command runs. ${GH_TOOL_SCOPE[scope]} The sandbox process receives only a placeholder GH_TOKEN that the firewall exchanges on matching GitHub requests. Commands run without an approval prompt; description records the GitHub-side result the command intends to produce. Use simple argv quoting only, never environment assignments, pipes, redirects, substitutions, or other shell syntax. gh alias and extension commands may execute local code, but remain sandboxed. Use gh-signed-commit only with --repo. Use ordinary bash for local git status, diff, add, commit, and rebase.`;
}

export const GH_TOOL_DESCRIPTION = ghToolDescription("repository");

const ghOutputSchema = z.object({
  exitCode: z.number().int(),
  stderr: z.string(),
  stdout: z.string(),
  truncated: z.boolean(),
});

/** The Connect-brokered `gh` tool, rebuilt by the dynamic resolver with its current config. */
export function defineGhTool(
  github: () => GitHubConfig | undefined,
  description = ghToolDescription(github()?.principalType === "user" ? "caller" : "repository"),
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
        getToken: (provider, options) => ctx.getToken(provider, options),
        requireAuth: (provider, options) => ctx.requireAuth(provider, options),
        getSandbox: () => ctx.getSandbox(),
        sessionId: ctx.session.id,
      });
    },
  });
}
