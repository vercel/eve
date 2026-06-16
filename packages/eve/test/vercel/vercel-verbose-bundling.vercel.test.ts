import { afterAll, beforeAll, describe, it } from "vitest";
import { VERBOSE_BUNDLING_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/verbose-bundling.js";
import type { HandleMessageStreamEvent } from "../../src/protocol/message.js";
import type { RuntimeToolResultActionResult } from "../../src/runtime/actions/types.js";
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
      "Missing required environment variables for verbose-bundling Vercel deployment tests.",
      `Set: ${missingEnvironmentVariables.join(", ")}`,
    ].join("\n"),
  );
}

describe.sequential("verbose-bundling Vercel deployment integration", () => {
  let deploymentFixture: TarballVercelDeploymentFixture | undefined;

  beforeAll(async () => {
    deploymentFixture = await createTarballVercelDeploymentFixture({
      descriptor: VERBOSE_BUNDLING_DESCRIPTOR,
      orgId: readRequiredEnvironmentVariable("VERCEL_ORG_ID"),
      prefix: "eve-vercel-verbose-bundling-",
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
    "executes the snowflake inspection tool",
    async () => {
      const output = await sendToolMessageAndCollectResult({
        deploymentFixture,
        message:
          'Call exactly one tool named "inspect_snowflake_module" with no arguments. Do not call any other tools.',
        toolName: "inspect_snowflake_module",
      });
      expectToolOutput(output, "inspect_snowflake_module output");
    },
    5 * 60_000,
  );

  it(
    "executes the alias path tool",
    async () => {
      const output = await sendToolMessageAndCollectResult({
        deploymentFixture,
        message:
          'Call exactly one tool named "check_alias_paths" with no arguments. Do not call any other tools.',
        toolName: "check_alias_paths",
      });
      expectToolOutput(output, "check_alias_paths output");
    },
    5 * 60_000,
  );
});

async function sendToolMessageAndCollectResult(input: {
  readonly deploymentFixture: TarballVercelDeploymentFixture | undefined;
  readonly message: string;
  readonly toolName: string;
}): Promise<unknown> {
  const deploymentFixture = input.deploymentFixture;

  if (deploymentFixture === undefined) {
    throw new Error("Expected Vercel deployment fixture to be initialized.");
  }

  const response = await sendDevelopmentMessage({
    message: input.message,
    serverUrl: deploymentFixture.deploymentUrl,
    session: createDevelopmentSessionState(),
  });
  const toolResult = extractToolResult(response.events, input.toolName);

  if (toolResult === undefined) {
    throw new Error(
      [
        `Expected a tool-result for "${input.toolName}".`,
        `Observed stream events: ${response.events.map((event) => event.type).join(", ")}`,
      ].join("\n"),
    );
  }

  if (toolResult.isError === true) {
    throw new Error(
      `Tool "${input.toolName}" returned an error result: ${JSON.stringify(toolResult.output)}`,
    );
  }

  return toolResult.output;
}

function extractToolResult(
  events: readonly HandleMessageStreamEvent[],
  toolName: string,
): RuntimeToolResultActionResult | undefined {
  for (const event of events) {
    if (event.type !== "action.result") {
      continue;
    }

    if (event.data.result.kind !== "tool-result") {
      continue;
    }

    if (event.data.result.toolName !== toolName) {
      continue;
    }

    return event.data.result;
  }

  return undefined;
}

function expectToolOutput(value: unknown, label: string): void {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be present.`);
  }

  if (typeof value === "string" && value.trim().length === 0) {
    throw new Error(`Expected ${label} to be non-empty.`);
  }
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
