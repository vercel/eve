import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  executeGitHubShell,
  githubShellApproval,
  type GitHubConfig,
  type GitHubShellInput,
} from "./github-shell.ts";
import { githubAppShellInputSchema, githubShellInputSchema } from "./github-shell-schema.ts";

const GH_TOOL_SCOPE = {
  repository:
    "Connect mints a GitHub App installation token for that repository, or for the owner's installation when repository is an owner.",
  caller:
    "Connect resolves the caller's own GitHub token, which carries the caller's GitHub permissions, so GitHub allows whatever the caller can access.",
} as const;

const GH_TOOL_REPOSITORY = {
  repository:
    "Set repository to the owner/name the command acts on, or to an owner for discovery such as gh repo list <owner> or gh search repos --owner <owner>.",
  caller:
    "Set repository to the owner/name the command acts on, or omit it for commands that act on no single repository, such as gh repo list <owner>, gh search repos, or gh api user/repos.",
} as const;

const GH_TOOL_ACTOR = {
  repository: "",
  caller:
    "When several people talk in the conversation, set actor to the principalId of the person whose request the command carries out, as the sender lines name them, and the command runs with that person's own GitHub token. Omit it for the person whose message started this turn. A person who didn't send the latest message is asked to approve the command first.",
} as const;

/** Describes the `gh` tool for app-installation (`repository`) or user-scoped (`caller`) tokens. */
export function ghToolDescription(scope: keyof typeof GH_TOOL_SCOPE): string {
  const actor = GH_TOOL_ACTOR[scope] === "" ? "" : ` ${GH_TOOL_ACTOR[scope]}`;
  return `Run one authenticated gh, git, or gh-signed-commit command in the sandbox. The full gh and git CLI surface is available. ${GH_TOOL_REPOSITORY[scope]}${actor} The agent's access policy decides whether each command runs. ${GH_TOOL_SCOPE[scope]} The sandbox process receives only a placeholder GH_TOKEN that the firewall exchanges on matching GitHub requests. Commands run without an approval prompt; description records the GitHub-side result the command intends to produce. Use simple argv quoting only, never environment assignments, pipes, redirects, substitutions, or other shell syntax. gh alias and extension commands may execute local code, but remain sandboxed. Use gh-signed-commit only with --repo. Use ordinary bash for local git status, diff, add, commit, and rebase.`;
}

export const GH_TOOL_DESCRIPTION = ghToolDescription("repository");

const ghOutputSchema = z.object({
  exitCode: z.number().int(),
  stderr: z.string(),
  stdout: z.string(),
  truncated: z.boolean(),
});

/**
 * The Connect-brokered `gh` tool, rebuilt by the dynamic resolver with its current config. Only
 * user tokens act for a person, so only they offer `actor`; the config is fixed per deployment,
 * so the schema stays the same from turn to turn.
 */
export function defineGhTool(
  github: () => GitHubConfig | undefined,
  description = ghToolDescription(github()?.principalType === "user" ? "caller" : "repository"),
) {
  const userTokens = github()?.principalType === "user";
  return defineTool({
    description,
    approval: ({ toolInput }) => githubShellApproval(toolInput as GitHubShellInput | undefined),
    inputSchema: userTokens ? githubShellInputSchema : githubAppShellInputSchema,
    outputSchema: ghOutputSchema,
    label: {
      start: (input) => input.description,
    },
    execute(input, ctx) {
      return executeGitHubShell(input, github(), {
        context: ctx,
        auth: ctx.session.auth.current,
        sender: ctx.session.auth.sender,
        getToken: (provider, options) => ctx.getToken(provider, options),
        requireAuth: (provider, options) => ctx.requireAuth(provider, options),
        getSandbox: () => ctx.getSandbox(),
        sessionId: ctx.session.id,
        abortSignal: ctx.abortSignal,
      });
    },
  });
}
