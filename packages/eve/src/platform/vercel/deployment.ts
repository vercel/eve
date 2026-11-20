import type { PlatformDeployment } from "#platform/context.js";
import { isVercelEnvironment } from "#platform/vercel/environment.js";
import { resolveVercelProjectIdFromEnvironment } from "#platform/vercel/project.js";

function readTrimmed(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function readRaw(name: string): string | undefined {
  return process.env[name] || undefined;
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
  environmentName: () => readTrimmed("VERCEL_TARGET_ENV") ?? readTrimmed("VERCEL_ENV"),
  projectId: () => resolveVercelProjectIdFromEnvironment(),
  deploymentId: () => readTrimmed("VERCEL_DEPLOYMENT_ID"),
  hostedDeploymentId: () =>
    process.env.VERCEL === "1" ? readTrimmed("VERCEL_DEPLOYMENT_ID") : undefined,
  build() {
    const gitSha = readTrimmed("VERCEL_GIT_COMMIT_SHA");
    const gitBranch = readTrimmed("VERCEL_GIT_COMMIT_REF");
    const deployedAt = readTrimmed("VERCEL_DEPLOYMENT_CREATED_AT");
    if (gitSha === undefined && gitBranch === undefined && deployedAt === undefined) {
      return undefined;
    }
    return { deployedAt, gitBranch, gitSha };
  },
  productionHost: () => readRaw("VERCEL_PROJECT_PRODUCTION_URL"),
  deploymentHost: () => readRaw("VERCEL_URL"),
  publicHost: () => readRaw("VERCEL_PROJECT_PRODUCTION_URL") ?? readRaw("VERCEL_URL"),
  isPlatformDevelopmentServer: () =>
    isVercelEnvironment() && process.env.VERCEL_ENV === "development",
};
