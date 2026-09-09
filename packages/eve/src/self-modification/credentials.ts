import type { GitHubRepository, ResolvedGitHubCredentials } from "./config.js";

export type GitHubCredentialCapability = "checkout" | "publish";

export interface GitHubCredentialRequest {
  readonly capability: GitHubCredentialCapability;
  readonly repository: GitHubRepository;
}

export interface GitHubCredentialProvider {
  resolve(request: GitHubCredentialRequest): Promise<string>;
}

interface VercelConnectModule {
  getToken(
    connector: string,
    options: {
      readonly authorizationDetails: readonly {
        readonly repositories: readonly string[];
        readonly type: "github_app_installation";
      }[];
      readonly scopes: readonly string[];
      readonly subject: { readonly type: "app" };
    },
  ): Promise<string>;
}

export const SELF_MODIFICATION_GITHUB_TOKEN_ENV = "EVE_SELF_MODIFICATION_GITHUB_TOKEN";

/** Checks PAT availability without returning the credential. */
export function hasGitHubCredential(): boolean {
  return (process.env[SELF_MODIFICATION_GITHUB_TOKEN_ENV]?.trim().length ?? 0) > 0;
}

/** Constructs the configured provider without resolving a credential. */
export function createGitHubCredentialProvider(
  credentials: ResolvedGitHubCredentials,
): GitHubCredentialProvider {
  return credentials.kind === "pat"
    ? defaultGitHubCredentialProvider
    : createVercelConnectCredentialProvider(credentials.connector);
}

/** Resolves a PAT GitHub credential without exposing it to authored code. */
export async function resolveGitHubCredential(request: GitHubCredentialRequest): Promise<string> {
  return defaultGitHubCredentialProvider.resolve(request);
}

export const defaultGitHubCredentialProvider: GitHubCredentialProvider = {
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

export function createVercelConnectCredentialProvider(connector: string): GitHubCredentialProvider {
  return {
    async resolve(request) {
      try {
        const moduleName: string = "@vercel/connect";
        const { getToken } = (await import(moduleName)) as VercelConnectModule;
        const token = await getToken(connector, {
          authorizationDetails: [
            {
              type: "github_app_installation",
              repositories: [`${request.repository.owner}/${request.repository.repo}`],
            },
          ],
          scopes:
            request.capability === "checkout"
              ? ["contents:read", "metadata:read"]
              : ["contents:write", "pull_requests:write", "metadata:read"],
          subject: { type: "app" },
        });
        if (token.trim().length === 0) throw new Error("empty token");
        return token;
      } catch (error) {
        throw new Error(
          `Self-modification could not obtain a GitHub credential from Vercel Connect for ${connector}. Install and attach the configured GitHub connector to this Vercel project, install the managed GitHub App for the configured repository, then retry.`,
          { cause: error },
        );
      }
    },
  };
}
