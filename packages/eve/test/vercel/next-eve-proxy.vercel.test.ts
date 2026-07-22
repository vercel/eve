import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createNextEveProxyDescriptor } from "../../src/internal/testing/scenario-apps/next-eve-proxy.js";
import {
  createTarballVercelDeploymentFixture,
  type TarballVercelDeploymentFixture,
} from "../helpers/vercel-deployment-fixture.js";

const REQUIRED_VERCEL_ENV_NAMES = ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"] as const;
const missingEnvironmentVariables = REQUIRED_VERCEL_ENV_NAMES.filter(
  (name) => !hasEnvironmentVariable(name),
);

if (missingEnvironmentVariables.length > 0) {
  throw new Error(
    [
      "Missing required environment variables for Next.js proxy Vercel deployment tests.",
      `Set: ${missingEnvironmentVariables.join(", ")}`,
    ].join("\n"),
  );
}

describe.sequential("Next.js proxy with generated eve service", () => {
  let deploymentFixture: TarballVercelDeploymentFixture | undefined;

  beforeAll(async () => {
    deploymentFixture = await createTarballVercelDeploymentFixture({
      descriptor: createNextEveProxyDescriptor(),
      orgId: readRequiredEnvironmentVariable("VERCEL_ORG_ID"),
      prefix: "eve-vercel-next-proxy-",
      projectId: readRequiredEnvironmentVariable("VERCEL_PROJECT_ID"),
      scope: readOptionalEnvironmentVariable("VERCEL_SCOPE"),
      token: readRequiredEnvironmentVariable("VERCEL_TOKEN"),
      waitForHealth: false,
    });
  }, 20 * 60_000);

  afterAll(async () => {
    await deploymentFixture?.cleanup();
    deploymentFixture = undefined;
  });

  it("deploys from source without rejecting the host middleware mapping", () => {
    if (deploymentFixture === undefined) {
      throw new Error("Expected Vercel deployment fixture to be initialized.");
    }

    expect(deploymentFixture.deploymentUrl).toMatch(/^https:\/\//u);
  });
});

function hasEnvironmentVariable(name: string): boolean {
  return readOptionalEnvironmentVariable(name) !== undefined;
}

function readOptionalEnvironmentVariable(name: string): string | undefined {
  const value = process.env[name]?.trim();

  return value === undefined || value.length === 0 ? undefined : value;
}

function readRequiredEnvironmentVariable(name: string): string {
  const value = readOptionalEnvironmentVariable(name);

  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
