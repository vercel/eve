import { interactiveAsker } from "#setup/ask.js";
import type { AddChannelsDeps } from "#setup/boxes/add-channels.js";
import type { DeployProjectDeps } from "#setup/boxes/deploy-project.js";
import { deployChannelSetup } from "#setup/channel-setup-deployment.js";
import {
  channelSetupEnvironment,
  describeChannelSetupEnvironment,
} from "#setup/channel-setup-environment.js";
import {
  channelSetupIntegration,
  createChannelSetupUi,
} from "#setup/channel-setup-integrations.js";
import { detectDeployment, projectResolutionFromDeployment } from "#setup/project-resolution.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { isEveProject, type ChannelKind } from "#setup/scaffold/index.js";
import { createDefaultSetupState, type SetupState } from "#setup/state.js";
import { getVercelAuthStatus } from "#setup/vercel-project.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";
import type { RegistryCommandLogger } from "./registry.js";

export interface IntegrationSetupOptions {
  yes?: boolean;
}

export interface IntegrationSetupDependencies {
  createPrompter?: () => Prompter;
  detectDeployment: typeof detectDeployment;
  getVercelAuthStatus: typeof getVercelAuthStatus;
  addChannelsDeps?: AddChannelsDeps;
  deployProjectDeps?: DeployProjectDeps;
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

  try {
    if (kind !== "slack" && kind !== "web") {
      throw new Error(
        `Integration setup "${kind}" is not available in this version of eve. Upgrade eve and try again.`,
      );
    }
    const channelKind: ChannelKind = kind;
    const prompter = dependencies.createPrompter?.() ?? createPrompter();
    prompter.intro(`Set up ${channelSetupIntegration(channelKind).label}`);
    prompter.log.message("Checking Vercel setup...");
    const [deployment, authStatus] = await Promise.all([
      dependencies.detectDeployment(appRoot),
      dependencies.getVercelAuthStatus(appRoot),
    ]);
    const project = projectResolutionFromDeployment(deployment);
    const environment = channelSetupEnvironment(authStatus, project);
    prompter.log.info(describeChannelSetupEnvironment(environment));
    const state: SetupState = {
      ...createDefaultSetupState(),
      project,
      projectPath: { kind: "resolved", inPlace: true, path: appRoot },
      channelSelection: [channelKind],
    };
    const result = await channelSetupIntegration(channelKind).setup({
      environment,
      state,
      ui: createChannelSetupUi({ asker: interactiveAsker(prompter), prompter }),
      presetCreateSlackbot: options.yes ? true : undefined,
      presetPortableCredentials: options.yes ? true : undefined,
      skipDependencyMutation: true,
      deps: dependencies.addChannelsDeps,
    });
    if (result.kind === "cancelled") return;
    let finalState = result.state;
    const addedVercelChannel =
      finalState.slackbotAttached ||
      (environment.vercel.kind === "available" && finalState.channels.includes("web"));
    if (addedVercelChannel) {
      finalState = await deployChannelSetup({
        state: finalState,
        ui: createChannelSetupUi({ asker: interactiveAsker(prompter), prompter }),
        presetDeploy:
          options.yes === true
            ? true
            : !process.stdin.isTTY || !process.stdout.isTTY
              ? false
              : undefined,
        deps: dependencies.deployProjectDeps,
      });
    }
    prompter.outro(
      finalState.channels.includes(channelKind) ? "Integration set up." : "No changes made.",
    );
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
