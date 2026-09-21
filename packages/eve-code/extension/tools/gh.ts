import { defineTool } from "eve/tools";
import { z } from "zod";

import extension from "../extension.ts";
import {
  executeGitHubShell,
  githubShellApproval,
  type GitHubShellInput,
} from "../lib/github-shell.ts";

import { githubShellInputSchema } from "../lib/github-shell-schema.ts";

export default defineTool({
  description:
    "Run one authenticated GitHub command in the sandbox. The full gh CLI surface is available. Commands run without an approval prompt; description records the GitHub-side result the command intends to produce. Declare exactly one repository in the configured GitHub organization: Connect mints the real token for only that repository, and the sandbox process receives only a placeholder GH_TOKEN that the firewall exchanges on matching GitHub requests. GitHub rejects access outside the token's server-side repository scope; commands that explicitly name another repository with -R, --repo, --repo=, or a repository argument to gh repo clone, view, or fork are denied before minting. Use simple argv quoting only, never environment assignments, pipes, redirects, substitutions, or other shell syntax. gh alias and extension commands may execute local code, but remain sandboxed. Use git here only for authenticated fetch, pull, push, or ls-remote against a strictly validated origin, and use gh-signed-commit only with --repo. Use ordinary bash for local git status, diff, add, commit, and rebase.",
  approval: ({ toolInput }) => githubShellApproval(toolInput as GitHubShellInput | undefined),
  inputSchema: githubShellInputSchema,
  outputSchema: z.object({
    exitCode: z.number().int(),
    stderr: z.string(),
    stdout: z.string(),
    truncated: z.boolean(),
  }),
  execute(input, ctx) {
    return executeGitHubShell(input, extension.config.github, {
      getSandbox: () => ctx.getSandbox(),
    });
  },
});
