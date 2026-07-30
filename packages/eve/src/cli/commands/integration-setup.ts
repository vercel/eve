<<<<<<< HEAD
=======
import { basename } from "node:path";

import { interactiveAsker } from "#setup/ask.js";
import type { AddChannelsDeps } from "#setup/integrations/channel-scaffold.js";
import {
  channelSetupEnvironment,
  describeChannelSetupEnvironment,
} from "#setup/integrations/shared/environment.js";
import { channelSetupIntegration, createChannelSetupUi } from "#setup/integrations/registry.js";
import type { PhotonSetupDeps } from "#setup/photon-setup.js";
import {
  describePhotonSetupEnvironment,
  photonSetupEnvironment,
} from "#setup/photon-setup-environment.js";
import { createPhotonSetupUi, photonSetupIntegration } from "#setup/photon-setup-integrations.js";
import { detectDeployment, projectResolutionFromDeployment } from "#setup/project-resolution.js";
>>>>>>> 23729a51 (fix(eve): stabilize Photon setup)
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { createRegistrySetupClient } from "#setup/registry-setup-client.js";
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
<<<<<<< HEAD
    const result = await runIntegrationSetup(
      kind,
      {
        appRoot,
        prompter,
        signal: client?.signal ?? options.signal,
        yes: options.yes,
=======
    const signal = client?.signal ?? options.signal;
    const [deployment, authStatus] = await Promise.all([
      dependencies.detectDeployment(appRoot, { signal }),
      dependencies.getVercelAuthStatus(appRoot, { signal }),
    ]);
    const project = projectResolutionFromDeployment(deployment);

    if (kind === "photon") {
      const integration = photonSetupIntegration();
      prompter.intro(`Set up ${integration.label}`);
      prompter.log.message("Checking Vercel setup...");
      const environment = photonSetupEnvironment(authStatus, project);
      prompter.log.info(describePhotonSetupEnvironment(environment));
      const result = await integration.setup({
        environment,
        state: { agentName: basename(appRoot), project, projectPath: appRoot },
        ui: createPhotonSetupUi({ asker: interactiveAsker(prompter), prompter }),
        photonDeps: dependencies.photonDeps,
        signal,
      });
      if (result.kind === "cancelled") {
        client?.cancel();
        return;
      }
      prompter.outro("Integration set up.");
      client?.complete([
        ...(result.assignedPhoneNumber === undefined
          ? []
          : [
              {
                label: "Text your agent",
                value: result.assignedPhoneNumber,
                kind: "phone" as const,
              },
            ]),
        { label: "Photon project", value: result.dashboardUrl, kind: "url" },
      ]);
      return;
    }

    const channelKind: ChannelKind = kind;
    const integration = channelSetupIntegration(channelKind);
    prompter.intro(`Set up ${integration.label}`);
    prompter.log.message("Checking Vercel setup...");
    const environment = channelSetupEnvironment(authStatus, project);
    prompter.log.info(describeChannelSetupEnvironment(environment));
    const result = await integration.setup({
      environment,
      state: {
        ...createDefaultSetupState(),
        project,
        projectPath: { kind: "resolved", inPlace: true, path: appRoot },
>>>>>>> 23729a51 (fix(eve): stabilize Photon setup)
      },
      dependencies.runnerDeps,
    );
    if (result.kind === "cancelled") {
      client?.cancel();
      if (process.env.EVE_SETUP === "1") process.exitCode = 130;
      return;
    }
    prompter.outro("Integration set up.");
    client?.complete(result.facts);
  } catch (error) {
    client?.fail(error);
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
