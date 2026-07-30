import { interactiveAsker } from "#setup/ask.js";
import type { AddChannelsDeps } from "#setup/integrations/channel-scaffold.js";
import {
  channelSetupEnvironment,
  describeChannelSetupEnvironment,
} from "#setup/integrations/shared/environment.js";
import { channelSetupIntegration, createChannelSetupUi } from "#setup/integrations/registry.js";
import { detectDeployment, projectResolutionFromDeployment } from "#setup/project-resolution.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { createRegistrySetupClient } from "#setup/registry-setup-client.js";
import { isEveProject, type ChannelKind } from "#setup/scaffold/index.js";
import { createDefaultSetupState } from "#setup/state.js";
import { getVercelAuthStatus } from "#setup/vercel-project.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";
import type { RegistryCommandLogger } from "./registry.js";

export interface IntegrationSetupOptions {
  yes?: boolean;
  signal?: AbortSignal;
}

export interface IntegrationSetupDependencies {
  createPrompter?: () => Prompter;
  detectDeployment: typeof detectDeployment;
  getVercelAuthStatus: typeof getVercelAuthStatus;
  addChannelsDeps?: AddChannelsDeps;
}

const defaultIntegrationSetupDependencies: IntegrationSetupDependencies = {
  detectDeployment,
  getVercelAuthStatus,
};

/** Runs a built-in integration setup after its registry payload is installed. */
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
    if (kind !== "slack" && kind !== "web") {
      throw new Error(
        `Integration setup "${kind}" is not available in this version of eve. Upgrade eve and try again.`,
      );
    }
    const channelKind: ChannelKind = kind;
    const prompter = client?.prompter ?? dependencies.createPrompter?.() ?? createPrompter();
    const signal = client?.signal ?? options.signal;
    const integration = channelSetupIntegration(channelKind);
    prompter.intro(`Set up ${integration.label}`);
    prompter.log.message("Checking Vercel setup...");
    const [deployment, authStatus] = await Promise.all([
      dependencies.detectDeployment(appRoot, { signal }),
      dependencies.getVercelAuthStatus(appRoot, { signal }),
    ]);
    const project = projectResolutionFromDeployment(deployment);
    const environment = channelSetupEnvironment(authStatus, project);
    prompter.log.info(describeChannelSetupEnvironment(environment));
    const result = await integration.setup({
      environment,
      state: {
        ...createDefaultSetupState(),
        project,
        projectPath: { kind: "resolved", inPlace: true, path: appRoot },
      },
      ui: createChannelSetupUi({ asker: interactiveAsker(prompter), prompter }),
      presetCreateSlackbot: options.yes ? true : undefined,
      presetPortableCredentials: options.yes ? true : undefined,
      skipDependencyMutation: true,
      deps: dependencies.addChannelsDeps,
      signal,
    });
    if (result.kind === "cancelled") {
      client?.cancel();
      if (process.env.EVE_SETUP === "1") process.exitCode = 130;
      return;
    }
    prompter.outro("Integration set up.");
    client?.complete();
  } catch (error) {
    client?.fail(error);
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
