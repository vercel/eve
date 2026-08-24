import { assertGitRef, assertRepositoryPart } from "./identifiers.js";
import type { SelfModificationRepository } from "./git-workspace.js";

/** Shared configuration for local editing and deployed source changes. */
export interface SelfModificationConfig {
  /** Local source-editing policy. Enabled by default. */
  readonly development?: {
    readonly enabled?: boolean;
  };
  /** The repository that deployed self-modification is allowed to modify. */
  readonly source?: {
    readonly git: {
      /** Git host and repository path. The initial implementation supports github.com only. */
      readonly repository: string;
    };
  };
  /** How a deployed source change reaches the configured branch. */
  readonly change?: {
    /** Creates a provider-native review request. GitHub sources create draft pull requests. */
    readonly behavior: "review";
    /** Branch a review request targets. */
    readonly branch: string;
  };
}

export interface ResolvedSelfModificationConfig {
  readonly developmentEnabled: boolean;
  /** Internal GitHub review implementation for the configured source and change behavior. */
  readonly pullRequests?: ResolvedSelfModificationPullRequests;
}

export interface ResolvedSelfModificationPullRequests {
  readonly repository: SelfModificationRepository;
}

/** Defines the shared configuration consumed by the self-modification definitions. */
export function defineSelfModificationConfig(
  config: SelfModificationConfig = {},
): SelfModificationConfig {
  resolveSelfModificationConfig(config);
  return config;
}

export function resolveSelfModificationConfig(
  config: SelfModificationConfig = {},
): ResolvedSelfModificationConfig {
  const developmentEnabled = config.development?.enabled ?? true;
  if (typeof developmentEnabled !== "boolean") {
    throw new Error("Self-modification development.enabled must be a boolean.");
  }
  if (config.source === undefined && config.change === undefined) return { developmentEnabled };
  if (config.source === undefined || config.change === undefined) {
    throw new Error(
      "Self-modification deployed changes require both source and change configuration.",
    );
  }
  return {
    developmentEnabled,
    pullRequests: {
      repository: parseGitHubReviewConfig({
        branch: config.change.branch,
        behavior: config.change.behavior,
        repository: config.source.git.repository,
      }),
    },
  };
}

function parseGitHubReviewConfig(input: {
  readonly behavior: string;
  readonly branch: unknown;
  readonly repository: unknown;
}): SelfModificationRepository {
  if (input.behavior !== "review") {
    throw new Error('Self-modification change.behavior must be "review".');
  }
  if (typeof input.repository !== "string" || typeof input.branch !== "string") {
    throw new Error("Self-modification source.git.repository and change.branch must be strings.");
  }
  const match = /^github\.com\/([^/]+)\/([^/]+)$/u.exec(input.repository);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("Self-modification source.git.repository must use github.com/owner/repo form.");
  }
  assertRepositoryPart(match[1], "repository owner");
  assertRepositoryPart(match[2], "repository name");
  assertGitRef(input.branch, "change branch");
  return { owner: match[1], targetBranch: input.branch, repo: match[2] };
}
