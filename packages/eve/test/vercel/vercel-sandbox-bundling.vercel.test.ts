import { afterAll, beforeAll, describe, it } from "vitest";
import { SANDBOX_BUNDLING_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/sandbox-bundling.js";
import type { HandleMessageStreamEvent } from "../../src/protocol/message.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";
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
      "Missing required environment variables for sandbox-bundling Vercel deployment tests.",
      `Set: ${missingEnvironmentVariables.join(", ")}`,
    ].join("\n"),
  );
}

describe.sequential("sandbox-bundling Vercel deployment integration", () => {
  let deploymentFixture: TarballVercelDeploymentFixture | undefined;

  beforeAll(async () => {
    deploymentFixture = await createTarballVercelDeploymentFixture({
      descriptor: SANDBOX_BUNDLING_DESCRIPTOR,
      orgId: readRequiredEnvironmentVariable("VERCEL_ORG_ID"),
      prefix: "eve-vercel-sandbox-bundling-",
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
    "responds to a basic message after the framework bundle loads",
    async () => {
      // Reaching this point already proves the deployed function evaluated
      // its top-level module graph without crashing: the hosted bundle must
      // prune the local sandbox backend (Docker engine + optional just-bash
      // engine) via the sandbox-backend prune plugin, and resolve the Vercel
      // backend's vendored `@vercel/sandbox` chunk. The end-to-end message
      // round-trip then confirms the framework runtime path is wired up and
      // the response stream completes.
      if (deploymentFixture === undefined) {
        throw new Error("Expected Vercel deployment fixture to be initialized.");
      }

      const response = await sendDevelopmentMessage({
        message: "Reply with the single word: ready.",
        serverUrl: deploymentFixture.deploymentUrl,
        session: createDevelopmentSessionState(),
      });

      expectAtLeastOneAssistantTextEvent(response.events);
    },
    5 * 60_000,
  );
});

function expectAtLeastOneAssistantTextEvent(events: readonly HandleMessageStreamEvent[]): void {
  for (const event of events) {
    if (
      event.type === "message.completed" &&
      event.data.message !== null &&
      event.data.message.trim().length > 0
    ) {
      return;
    }
  }

  throw new Error(
    [
      "Expected at least one message.completed stream event with assistant text from the deployed agent.",
      `Observed: ${events.map((event) => event.type).join(", ")}`,
    ].join("\n"),
  );
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

  if (value === undefined || value.length === 0) {
    return undefined;
  }

  return value;
}

function readRequiredEnvironmentVariable(name: string): string {
  const value = readOptionalEnvironmentVariable(name);

  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
