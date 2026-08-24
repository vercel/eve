import { getDeploymentSource, type DeploymentSource } from "eve";

import type { ResolvedSelfModificationPullRequests } from "./config.js";

const TOKEN_ENV = "EVE_SELF_MODIFICATION_GITHUB_TOKEN";

export function assertSelfModificationPullRequestsAvailable(input: {
  readonly pullRequests: ResolvedSelfModificationPullRequests;
  readonly source?: DeploymentSource | null;
}): DeploymentSource {
  const source = input.source === undefined ? getDeploymentSource() : input.source;
  if (source === null) {
    throw new Error("Deployed self-modification requires deployment source metadata.");
  }
  if (
    source.repository !==
    `github.com/${input.pullRequests.repository.owner}/${input.pullRequests.repository.repo}`
  ) {
    throw new Error(
      "Self-modification pull request repository does not match the deployed source.",
    );
  }
  return source;
}

export function canUseSelfModificationPullRequests(input: {
  readonly pullRequests: ResolvedSelfModificationPullRequests;
}): boolean {
  try {
    assertSelfModificationPullRequestsAvailable(input);
    return true;
  } catch {
    return false;
  }
}

export function resolvePersonalAccessToken(): string {
  const token = process.env[TOKEN_ENV]?.trim();
  if (token === undefined || token.length === 0) {
    throw new Error(`${TOKEN_ENV} is required for deployed self-modification.`);
  }
  return token;
}
