import { z } from "zod";

/** An `owner` or `owner/name` GitHub target. */
export const GITHUB_TARGET = /^([A-Za-z0-9][A-Za-z0-9-]*)(?:\/([A-Za-z0-9._-]+))?$/u;

export const githubShellInputSchema = z.object({
  command: z.string().trim().min(1).max(20_000),
  repository: z
    .string()
    .trim()
    .regex(GITHUB_TARGET)
    .optional()
    .describe(
      "the owner/name repository the command acts on, or an owner for discovery such as gh repo list <owner>; omit for commands tied to no owner",
    ),
  description: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("the concrete GitHub-side result expected from this command"),
  workingDirectory: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .optional()
    .describe("sandbox workspace directory; defaults to the workspace root"),
});

/**
 * Thrown when a GitHub command's own input is refused before it runs, such as
 * shell syntax, a working directory outside the workspace, or a missing body
 * file. The agent can fix these by changing the call.
 */
export class GitHubCommandInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubCommandInputError";
  }
}

/**
 * Type guard for {@link GitHubCommandInputError}.
 *
 * Uses `err.name` rather than `instanceof` because consumers and eve can end
 * up with different class identities after bundling.
 */
export function isGitHubCommandInputError(err: unknown): err is GitHubCommandInputError {
  return err instanceof Error && err.name === "GitHubCommandInputError";
}
