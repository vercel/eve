import type { GitHubCredentialProvider, ResolvedGitHubCredentials } from "./config.js";

export const SELF_MODIFICATION_GITHUB_TOKEN_ENV = "EVE_SELF_MODIFICATION_GITHUB_TOKEN";

/** Checks PAT availability without returning the credential. */
export function hasGitHubCredential(): boolean {
  return (process.env[SELF_MODIFICATION_GITHUB_TOKEN_ENV]?.trim().length ?? 0) > 0;
}

/** Constructs the configured provider without resolving a credential. */
export function createGitHubCredentialProvider(
  credentials: ResolvedGitHubCredentials,
): GitHubCredentialProvider {
  if (credentials.kind === "pat") return defaultGitHubCredentialProvider;
  return {
    async resolve(request) {
      const token = await credentials.provider.resolve(request);
      if (typeof token !== "string" || token.trim().length === 0) {
        throw new Error("Self-modification credential provider returned an empty GitHub token.");
      }
      return token.trim();
    },
  };
}

const defaultGitHubCredentialProvider: GitHubCredentialProvider = {
  async resolve() {
    const token = process.env[SELF_MODIFICATION_GITHUB_TOKEN_ENV];
    if (token === undefined || token.trim().length === 0) {
      throw new Error(
        `Self-modification requires ${SELF_MODIFICATION_GITHUB_TOKEN_ENV} in the deployment environment.`,
      );
    }
    return token.trim();
  },
};
