import { execFileSync } from "node:child_process";
import { relative } from "node:path";

import type { DeploymentSource } from "#public/deployment/index.js";

interface DeploymentSourceEnvironment {
  readonly EVE_SOURCE_REPOSITORY?: string;
  readonly EVE_SOURCE_REVISION?: string;
  readonly EVE_SOURCE_ROOT?: string;
  readonly VERCEL_GIT_COMMIT_SHA?: string;
  readonly VERCEL_GIT_PROVIDER?: string;
  readonly VERCEL_GIT_REPO_OWNER?: string;
  readonly VERCEL_GIT_REPO_SLUG?: string;
}

/** Captures the source identity needed to reproduce a production build. */
export function resolveDeploymentSource(input: {
  readonly appRoot: string;
  readonly env?: DeploymentSourceEnvironment;
  readonly gitRoot?: (appRoot: string) => string | undefined;
}): DeploymentSource | null {
  const env = input.env ?? process.env;
  const explicitValues = [env.EVE_SOURCE_REPOSITORY, env.EVE_SOURCE_REVISION, env.EVE_SOURCE_ROOT];
  if (explicitValues.some(hasValue)) {
    if (!explicitValues.every(hasValue)) return null;
    return source({
      repository: env.EVE_SOURCE_REPOSITORY!,
      revision: env.EVE_SOURCE_REVISION!,
      rootDirectory: env.EVE_SOURCE_ROOT!,
    });
  }

  const platformValues = [
    env.VERCEL_GIT_PROVIDER,
    env.VERCEL_GIT_REPO_OWNER,
    env.VERCEL_GIT_REPO_SLUG,
    env.VERCEL_GIT_COMMIT_SHA,
  ];
  if (!platformValues.some(hasValue)) return null;
  if (!platformValues.every(hasValue) || env.VERCEL_GIT_PROVIDER !== "github") return null;

  const repositoryRoot = (input.gitRoot ?? resolveGitRoot)(input.appRoot);
  if (repositoryRoot === undefined) return null;
  return source({
    repository: `github.com/${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}`,
    revision: env.VERCEL_GIT_COMMIT_SHA!,
    rootDirectory: relative(repositoryRoot, input.appRoot),
  });
}

function source(input: DeploymentSource): DeploymentSource | null {
  const repository = normalizeRepository(input.repository);
  const revision = normalizeRevision(input.revision);
  const rootDirectory = normalizeRootDirectory(input.rootDirectory);
  return repository === undefined || revision === undefined || rootDirectory === undefined
    ? null
    : { repository, revision, rootDirectory };
}

function resolveGitRoot(appRoot: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: appRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return undefined;
  }
}

function normalizeRepository(value: string): string | undefined {
  const normalized = value.trim().replace(/\.git$/u, "");
  const match = /^github\.com\/([^/]+)\/([^/]+)$/u.exec(normalized);
  return match !== null && [match[1], match[2]].every(isSafeSegment) ? normalized : undefined;
}

function normalizeRevision(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{40}$/u.test(normalized) ? normalized : undefined;
}

function normalizeRootDirectory(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "") || ".";
  if (normalized === ".") return normalized;
  return normalized.split("/").every(isSafeSegment) ? normalized : undefined;
}

function isSafeSegment(value: string | undefined): boolean {
  return (
    value !== undefined && value.length > 0 && value !== "." && value !== ".." && !/\s/u.test(value)
  );
}

function hasValue(value: string | undefined): boolean {
  return value?.trim().length !== 0 && value !== undefined;
}
