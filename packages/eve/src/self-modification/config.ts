import { assertGitRef, assertRepositoryPart } from "./identifiers.js";

export interface SelfModificationConfig {
  readonly local?: { readonly enabled?: boolean };
  readonly deployed?: {
    readonly source: {
      readonly git: {
        /** GitHub repository in github.com/owner/repository form. */
        readonly repository: string;
        /** Application directory relative to the repository root. */
        readonly directory: string;
      };
    };
    readonly target: { readonly branch: string };
    readonly credentials?: {
      /** Ephemeral, repository-scoped GitHub App credentials from Vercel Connect. */
      readonly vercelConnect?: { readonly connector: string };
      /**
       * Self-hosted exception. Reads `EVE_SELF_MODIFICATION_GITHUB_TOKEN` from
       * the trusted deployment environment; never injects it into the sandbox.
       */
      readonly pat?: true;
    };
  };
}

export interface ResolvedSelfModificationConfig {
  readonly localEnabled: boolean;
  readonly deployed?: ResolvedDeployedSelfModificationConfig;
}

export interface ResolvedDeployedSelfModificationConfig {
  readonly credentials: ResolvedGitHubCredentials;
  readonly directory: string;
  readonly repository: GitHubRepository;
  readonly targetBranch: string;
}

export type ResolvedGitHubCredentials =
  | { readonly kind: "pat" }
  | { readonly connector: string; readonly kind: "vercel-connect" };

export interface GitHubRepository {
  readonly owner: string;
  readonly repo: string;
}

/** Defines the policy shared by the self-modification agent, sandbox, and extension. */
export function defineSelfModificationConfig(
  config: SelfModificationConfig = {},
): SelfModificationConfig {
  resolveSelfModificationConfig(config);
  return config;
}

export function resolveSelfModificationConfig(
  config: SelfModificationConfig = {},
): ResolvedSelfModificationConfig {
  if (!isRecord(config)) throw new Error("Self-modification configuration must be an object.");

  const local = config.local;
  if (local !== undefined && !isRecord(local)) {
    throw new Error("Self-modification local must be an object.");
  }
  const localEnabled = local?.enabled ?? true;
  if (typeof localEnabled !== "boolean") {
    throw new Error("Self-modification local.enabled must be a boolean.");
  }

  const deployed = config.deployed;
  if (deployed === undefined) return { localEnabled };
  if (!isRecord(deployed)) throw new Error("Self-modification deployed must be an object.");
  const { source, target, credentials } = deployed;
  if (source === undefined || target === undefined) {
    throw new Error("Self-modification deployed requires both source and target configuration.");
  }
  if (!isRecord(source)) throw new Error("Self-modification deployed.source must be an object.");
  if (!isRecord(source.git)) {
    throw new Error("Self-modification deployed.source.git must be an object.");
  }
  if (!isRecord(target)) throw new Error("Self-modification deployed.target must be an object.");

  const { git } = source;
  if (typeof git.repository !== "string" || typeof git.directory !== "string") {
    throw new Error(
      "Self-modification deployed.source.git.repository and deployed.source.git.directory must be strings.",
    );
  }
  if (typeof target.branch !== "string") {
    throw new Error("Self-modification deployed.target.branch must be a string.");
  }
  return {
    deployed: {
      credentials: parseCredentials(credentials),
      directory: parseDirectory(git.directory),
      repository: parseGitHubRepository(git.repository),
      targetBranch: parseBranch(target.branch),
    },
    localEnabled,
  };
}

function parseCredentials(value: unknown): ResolvedGitHubCredentials {
  if (!isRecord(value)) {
    throw new Error(
      "Self-modification deployed.credentials must explicitly configure Vercel Connect or the self-hosted PAT exception.",
    );
  }
  const hasConnect = value.vercelConnect !== undefined;
  const hasPat = value.pat !== undefined;
  if (hasConnect === hasPat) {
    throw new Error(
      "Self-modification deployed.credentials must configure exactly one of vercelConnect or pat.",
    );
  }
  if (value.pat !== undefined) {
    if (value.pat !== true) {
      throw new Error("Self-modification deployed.credentials.pat must be true.");
    }
    return { kind: "pat" };
  }
  if (!isRecord(value.vercelConnect)) {
    throw new Error("Self-modification deployed.credentials.vercelConnect must be an object.");
  }
  const connector = value.vercelConnect.connector;
  if (typeof connector !== "string" || connector.trim().length === 0) {
    throw new Error(
      "Self-modification deployed.credentials.vercelConnect.connector must be a string.",
    );
  }
  return { connector: connector.trim(), kind: "vercel-connect" };
}

function parseGitHubRepository(repository: string): GitHubRepository {
  const match = /^github\.com\/([^/]+)\/([^/]+)$/u.exec(repository);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(
      "Self-modification deployed.source.git.repository must use github.com/owner/repo form.",
    );
  }
  assertRepositoryPart(match[1], "repository owner");
  assertRepositoryPart(match[2], "repository name");
  return { owner: match[1], repo: match[2] };
}

function parseDirectory(directory: string): string {
  if (
    directory !== "." &&
    (directory.length === 0 ||
      directory.startsWith("/") ||
      directory.includes("\\") ||
      directory.split("/").some((part) => part === "" || part === "." || part === ".."))
  ) {
    throw new Error(
      "Self-modification deployed.source.git.directory must be a safe repository-relative path.",
    );
  }
  return directory;
}

function parseBranch(branch: string): string {
  assertGitRef(branch, "target branch");
  if (branch.startsWith("refs/")) {
    throw new Error(
      "Self-modification deployed.target.branch must be a branch name, not a full Git ref.",
    );
  }
  return branch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
