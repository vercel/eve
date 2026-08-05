import { createPrompter, type Prompter } from "#setup/prompter.js";
import { createRegistrySetupClient } from "#setup/registry-setup-client.js";
import type { RegistrySetupCompletion } from "#setup/registry-setup-protocol.js";
import {
  runIntegrationSetup,
  type IntegrationSetupRunnerDeps,
} from "#setup/integrations/runner.js";
import { isEveProject } from "#setup/scaffold/index.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";
import type { RegistryCommandLogger } from "./registry.js";

export interface IntegrationSetupOptions {
  yes?: boolean;
  signal?: AbortSignal;
}

export interface IntegrationSetupDependencies {
  createPrompter?: () => Prompter;
  runnerDeps?: IntegrationSetupRunnerDeps;
}

const defaultIntegrationSetupDependencies: IntegrationSetupDependencies = {};

/** Runs built-in integration setup after its registry payload is installed. */
export async function runIntegrationSetupCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  kind: string,
  options: IntegrationSetupOptions = {},
  dependencies: IntegrationSetupDependencies = defaultIntegrationSetupDependencies,
): Promise<void> {
  if (!(await isEveProject(appRoot))) {
    logger.error(NOT_AN_AGENT_MESSAGE);
    process.exitCode = 1;
    return;
  }

  const client = createRegistrySetupClient({ signal: options.signal });
  try {
    const prompter = client?.prompter ?? dependencies.createPrompter?.() ?? createPrompter();
    const result = await runIntegrationSetup(
      kind,
      {
        appRoot,
        prompter,
        signal: client?.signal ?? options.signal,
        yes: options.yes,
      },
      dependencies.runnerDeps,
    );
    if (result.kind === "cancelled") {
      client?.cancel();
      if (process.env.EVE_SETUP === "1") process.exitCode = 130;
      return;
    }
    prompter.outro("Integration set up.");
    const completion: RegistrySetupCompletion = { facts: result.facts ?? [] };
    if (result.deploymentRequired === true) {
      completion.deployment = { required: true };
      if (result.productionDestinations !== undefined) {
        completion.deployment.productionDestinations = result.productionDestinations;
      }
    }
    client?.complete(completion);
  } catch (error) {
    client?.fail(error);
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
