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
    "Connect mints the real token for only that repository, and the sandbox process receives only a placeholder GH_TOKEN that the firewall exchanges on matching GitHub requests. GitHub rejects access outside the token's server-side repository scope; commands that explicitly name another repository with -R, --repo, --repo=, or a repository argument to gh repo clone, view, or fork are denied before minting.",
  caller:
    "Connect resolves the caller's own GitHub token for that command, and the sandbox process receives only a placeholder GH_TOKEN that the firewall exchanges on matching GitHub requests. The token carries the caller's GitHub permissions, so GitHub allows whatever the caller can access; commands that explicitly name another repository with -R, --repo, --repo=, or a repository argument to gh repo clone, view, or fork are denied before the token is resolved.",
} as const;

/** Describes the `gh` tool for app-installation (`repository`) or user-scoped (`caller`) tokens. */
export function ghToolDescription(scope: keyof typeof GH_TOOL_SCOPE): string {
  return `Run one authenticated GitHub command in the sandbox. The full gh CLI surface is available. Commands run without an approval prompt; description records the GitHub-side result the command intends to produce. Declare exactly one owner/name repository; the agent's access policy decides which repositories commands may use. ${GH_TOOL_SCOPE[scope]} Use simple argv quoting only, never environment assignments, pipes, redirects, substitutions, or other shell syntax. gh alias and extension commands may execute local code, but remain sandboxed. Use git here only for authenticated fetch, pull, push, or ls-remote against a strictly validated origin, and use gh-signed-commit only with --repo. Use ordinary bash for local git status, diff, add, commit, and rebase.`;
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
