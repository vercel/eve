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
