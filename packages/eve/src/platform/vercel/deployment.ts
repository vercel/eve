import type { Deployment, DeploymentBuild } from "#platform/entities.js";
import { isVercelEnvironment } from "#platform/vercel/environment.js";
import { resolveVercelProjectIdFromEnvironment } from "#platform/vercel/project.js";

function readTrimmed(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function readRaw(name: string): string | undefined {
  return process.env[name] || undefined;
}

export function vercelEnvironmentName(): string | undefined {
  return readTrimmed("VERCEL_TARGET_ENV") ?? readTrimmed("VERCEL_ENV");
}

function vercelDeploymentBuild(): DeploymentBuild | undefined {
  const gitSha = readTrimmed("VERCEL_GIT_COMMIT_SHA");
  const gitBranch = readTrimmed("VERCEL_GIT_COMMIT_REF");
  const deployedAt = readTrimmed("VERCEL_DEPLOYMENT_CREATED_AT");
  if (gitSha === undefined && gitBranch === undefined && deployedAt === undefined) {
    return undefined;
  }
  return { deployedAt, gitBranch, gitSha };
}

export function vercelDeploymentHost(): string | undefined {
  return readRaw("VERCEL_URL");
}

export const vercelDeployment = {
  environment() {
    const environment = process.env.VERCEL_ENV;
    return environment === "development" ||
      environment === "preview" ||
      environment === "production"
      ? environment
      : undefined;
  },
  deploymentId: () => readTrimmed("VERCEL_DEPLOYMENT_ID"),
  invocationData(): Readonly<Record<string, string>> {
    const deploymentId =
      process.env.VERCEL === "1" ? readTrimmed("VERCEL_DEPLOYMENT_ID") : undefined;
    return deploymentId === undefined ? {} : { vercelDeploymentId: deploymentId };
  },
  build: vercelDeploymentBuild,
  productionHost: () => readRaw("VERCEL_PROJECT_PRODUCTION_URL"),
  publicHost: () => readRaw("VERCEL_PROJECT_PRODUCTION_URL") ?? readRaw("VERCEL_URL"),
  localDevelopment: () => isVercelEnvironment() && process.env.VERCEL_ENV === "development",
  scope() {
    const projectId = resolveVercelProjectIdFromEnvironment();
    if (projectId === undefined) return undefined;
    const environment = vercelEnvironmentName() ?? "production";
    const variant =
      environment === "preview"
        ? vercelDeploymentBuild()?.gitBranch ||
          readTrimmed("VERCEL_DEPLOYMENT_ID") ||
          readRaw("VERCEL_URL")?.trim() ||
          "unknown-preview"
        : null;
    return { environment, id: projectId, platform: "vercel", variant };
  },
} satisfies Deployment;
