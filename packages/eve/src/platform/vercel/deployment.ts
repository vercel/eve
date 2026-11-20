import type { PlatformDeployment } from "#platform/types.js";

function readTrimmed(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export const vercelDeployment: PlatformDeployment = {
  environmentKind() {
    const environment = process.env.VERCEL_ENV;
    return environment === "development" ||
      environment === "preview" ||
      environment === "production"
      ? environment
      : undefined;
  },
  deploymentId: () => readTrimmed("VERCEL_DEPLOYMENT_ID"),
  build() {
    const gitSha = readTrimmed("VERCEL_GIT_COMMIT_SHA");
    const gitBranch = readTrimmed("VERCEL_GIT_COMMIT_REF");
    const deployedAt = readTrimmed("VERCEL_DEPLOYMENT_CREATED_AT");
    if (gitSha === undefined && gitBranch === undefined && deployedAt === undefined) {
      return undefined;
    }
    return { deployedAt, gitBranch, gitSha };
  },
  publicHost: () =>
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || undefined,
};
