import {
  defineDurableCallback,
  defineDurableSchema,
  defineTool,
  type ToolContext,
} from "eve/tools";
import { z } from "zod";

import {
  executeGitHubShell,
  githubShellApproval,
  type GitHubConfig,
  type GitHubShellInput,
} from "./github-shell.ts";
import { githubShellInputSchema } from "./github-shell-schema.ts";

export const GH_TOOL_DESCRIPTION =
  "Run one authenticated GitHub command in the sandbox. The full gh CLI surface is available. Commands run without an approval prompt; description records the GitHub-side result the command intends to produce. Declare exactly one repository in the configured GitHub organization: Connect mints the real token for only that repository, and the sandbox process receives only a placeholder GH_TOKEN that the firewall exchanges on matching GitHub requests. GitHub rejects access outside the token's server-side repository scope; commands that explicitly name another repository with -R, --repo, --repo=, or a repository argument to gh repo clone, view, or fork are denied before minting. Use simple argv quoting only, never environment assignments, pipes, redirects, substitutions, or other shell syntax. gh alias and extension commands may execute local code, but remain sandboxed. Use git here only for authenticated fetch, pull, push, or ls-remote against a strictly validated origin, and use gh-signed-commit only with --repo. Use ordinary bash for local git status, diff, add, commit, and rebase.";

const ghOutputSchema = z.object({
  exitCode: z.number().int(),
  stderr: z.string(),
  stdout: z.string(),
  truncated: z.boolean(),
});

/**
 * The Connect-brokered `gh` tool, bound to one extension's GitHub config.
 *
 * Callbacks declare durable descriptors with empty closures: eve's transform
 * would capture the `github` getter, which is not JSON, and imports through
 * `eve/extensions/git/sandbox` are not transformed. The getter is boot-time
 * wiring, not per-tool data; a fresh process reruns the dynamic resolver
 * before replay, which binds a new getter.
 */
export function defineGhTool(
  github: () => GitHubConfig | undefined,
  description = GH_TOOL_DESCRIPTION,
) {
  return defineTool({
    description,
    approval: defineDurableCallback({
      closure: {},
      callback: (_closure, { toolInput }: { readonly toolInput?: unknown }) =>
        githubShellApproval(toolInput as GitHubShellInput | undefined),
    }),
    inputSchema: defineDurableSchema({ closure: {}, schema: () => githubShellInputSchema }),
    outputSchema: defineDurableSchema({ closure: {}, schema: () => ghOutputSchema }),
    execute: defineDurableCallback({
      closure: {},
      callback: (_closure, input: GitHubShellInput, ctx: ToolContext) =>
        executeGitHubShell(input, github(), {
          context: ctx,
          auth: ctx.session.auth.current,
          getSandbox: () => ctx.getSandbox(),
          sessionId: ctx.session.id,
        }),
    }),
  });
}
