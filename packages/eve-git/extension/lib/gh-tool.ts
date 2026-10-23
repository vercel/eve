import { defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";

import {
  executeGitHubShell,
  githubShellApproval,
  type GitHubConfig,
  type GitHubShellInput,
  type GitHubShellOutput,
} from "./github-shell.ts";
import { githubShellInputSchema } from "./github-shell-schema.ts";

export const GH_TOOL_DESCRIPTION =
  "Run one authenticated GitHub command in the sandbox. The full gh CLI surface is available. Commands run without an approval prompt; description records the GitHub-side result the command intends to produce. Declare exactly one repository in the configured GitHub organization: Connect mints the real token for only that repository, and the sandbox process receives only a placeholder GH_TOKEN that the firewall exchanges on matching GitHub requests. GitHub rejects access outside the token's server-side repository scope; commands that explicitly name another repository with -R, --repo, --repo=, or a repository argument to gh repo clone, view, or fork are denied before minting. Use simple argv quoting only, never environment assignments, pipes, redirects, substitutions, or other shell syntax. gh alias and extension commands may execute local code, but remain sandboxed. Use git here only for authenticated fetch, pull, push, or ls-remote against a strictly validated origin, and use gh-signed-commit only with --repo. Use ordinary bash for local git status, diff, add, commit, and rebase.";

export const ghToolOutputSchema = z.object({
  exitCode: z.number().int(),
  stderr: z.string(),
  stdout: z.string(),
  truncated: z.boolean(),
});

/** Denies a malformed `gh` call before it runs; valid calls need no approval. */
export function ghToolApproval({ toolInput }: { readonly toolInput?: unknown }) {
  return githubShellApproval(toolInput as GitHubShellInput | undefined);
}

/** Runs one `gh` tool call with an extension's GitHub config. */
export function runGhTool(
  input: GitHubShellInput,
  ctx: ToolContext,
  github: GitHubConfig | undefined,
): Promise<GitHubShellOutput> {
  return executeGitHubShell(input, github, {
    context: ctx,
    auth: ctx.session.auth.current,
    getSandbox: () => ctx.getSandbox(),
    sessionId: ctx.session.id,
  });
}

/**
 * The Connect-brokered `gh` tool, bound to one extension's GitHub config, for
 * static use only. Its `execute` captures the `github` getter, which a dynamic
 * tool can't persist. A `defineDynamic` resolver must define the tool inline
 * from the same parts (`ghToolApproval`, `githubShellInputSchema`,
 * `ghToolOutputSchema`, `runGhTool`) and read its extension's config from a
 * module-level import, as `tools/gh.ts` does.
 */
export function defineGhTool(
  github: () => GitHubConfig | undefined,
  description = GH_TOOL_DESCRIPTION,
) {
  return defineTool({
    description,
    approval: ghToolApproval,
    inputSchema: githubShellInputSchema,
    outputSchema: ghToolOutputSchema,
    execute(input, ctx) {
      return runGhTool(input, ctx, github());
    },
  });
}
