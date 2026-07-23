import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SESSION_RESET_DESCRIPTOR } from "#internal/testing/scenario-apps/session-reset.js";
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
      "Missing required environment variables for session-reset Vercel deployment tests.",
      `Set: ${missingEnvironmentVariables.join(", ")}`,
    ].join("\n"),
  );
}

describe.sequential("session reset Vercel deployment integration", () => {
  let deploymentFixture: TarballVercelDeploymentFixture | undefined;

  beforeAll(async () => {
    deploymentFixture = await createTarballVercelDeploymentFixture({
      descriptor: SESSION_RESET_DESCRIPTOR,
      orgId: readRequiredEnvironmentVariable("VERCEL_ORG_ID"),
      prefix: "eve-vercel-session-reset-",
      projectId: readRequiredEnvironmentVariable("VERCEL_PROJECT_ID"),
      runtimeEnv: collectDeploymentEnvironment(["AI_GATEWAY_API_KEY"]),
      scope: readOptionalEnvironmentVariable("VERCEL_SCOPE"),
      token: readRequiredEnvironmentVariable("VERCEL_TOKEN"),
    });
  }, 20 * 60_000);

  afterAll(async () => {
    await deploymentFixture?.cleanup();
    deploymentFixture = undefined;
  });

  it(
    "releases a stable continuation token before the next message starts",
    async () => {
      const deploymentUrl = deploymentFixture?.deploymentUrl;
      if (deploymentUrl === undefined) {
        throw new Error("Expected Vercel deployment fixture to be initialized.");
      }

      const threadId = `thread-${crypto.randomUUID()}`;
      const first = await postJson(deploymentUrl, `/session-reset/${threadId}/messages`, {
        message: "Write a detailed 1,000-word explanation of test isolation.",
      });
      const firstSessionId = requireString(first, "sessionId");

      await expect(waitForOwner(deploymentUrl, threadId, "present")).resolves.toBe(firstSessionId);

      const reset = await postJson(deploymentUrl, `/session-reset/${threadId}/new`);
      expect(reset).toEqual({ previousSessionId: firstSessionId, status: "reset" });

      await expect(waitForOwner(deploymentUrl, threadId, "absent")).resolves.toBeNull();

      const second = await postJson(deploymentUrl, `/session-reset/${threadId}/messages`, {
        message: "Give another concise greeting.",
      });
      expect(requireString(second, "sessionId")).not.toBe(firstSessionId);
    },
    5 * 60_000,
  );
});

async function postJson(
  deploymentUrl: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, deploymentUrl), {
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const value: unknown = await response.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected the channel route to return a JSON object.");
  }
  return value as Record<string, unknown>;
}

async function waitForOwner(
  deploymentUrl: string,
  threadId: string,
  expected: "absent" | "present",
): Promise<string | null> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const response = await postJson(deploymentUrl, `/session-reset/${threadId}/owner`);
    const sessionId = response.sessionId;
    const owner = typeof sessionId === "string" ? sessionId : null;

    if ((expected === "present" && owner !== null) || (expected === "absent" && owner === null)) {
      return owner;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for the continuation token owner to become ${expected}.`);
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Expected response field ${key} to be a non-empty string.`);
  }
  return field;
}

function collectDeploymentEnvironment(names: readonly string[]): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const name of names) {
    const value = readOptionalEnvironmentVariable(name);
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
}

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
