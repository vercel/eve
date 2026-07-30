import { interactiveAsker } from "#setup/ask.js";
import type { RegistrySetupFact } from "#setup/registry-setup-protocol.js";
import { detectDeployment, projectResolutionFromDeployment } from "#setup/project-resolution.js";
import type { Prompter } from "#setup/prompter.js";
import { createDefaultSetupState } from "#setup/state.js";
import { getVercelAuthStatus } from "#setup/vercel-project.js";

import type { AddChannelsDeps } from "./channel-scaffold.js";
import { channelSetupEnvironment, describeChannelSetupEnvironment } from "./shared/environment.js";
import { createChannelSetupUi } from "./shared/ui.js";
import { setupIntegration } from "./registry.js";

/** Inputs shared by every registry-owned integration setup flow. */
export interface RunIntegrationSetupOptions {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  yes?: boolean;
}

/** Effects shared by the built-in integration setup runner. */
export interface IntegrationSetupRunnerDeps {
  detectDeployment: typeof detectDeployment;
  getVercelAuthStatus: typeof getVercelAuthStatus;
  addChannelsDeps?: AddChannelsDeps;
}

const defaultDeps: IntegrationSetupRunnerDeps = {
  detectDeployment,
  getVercelAuthStatus,
};

/** Outcome returned by one registry-owned integration setup flow. */
export type IntegrationSetupOutcome =
  | { kind: "cancelled" }
  | { kind: "done"; facts?: readonly RegistrySetupFact[] };

/** Runs one built-in integration setup flow selected by its registry setup name. */
export async function runIntegrationSetup(
  kind: string,
  options: RunIntegrationSetupOptions,
  deps: IntegrationSetupRunnerDeps = defaultDeps,
): Promise<IntegrationSetupOutcome> {
  const integration = setupIntegration(kind);
  options.prompter.intro(`Set up ${integration.label}`);
  options.prompter.log.message("Checking Vercel setup...");
  const [deployment, authStatus] = await Promise.all([
    deps.detectDeployment(options.appRoot, { signal: options.signal }),
    deps.getVercelAuthStatus(options.appRoot, { signal: options.signal }),
  ]);
  const project = projectResolutionFromDeployment(deployment);
  const environment = channelSetupEnvironment(authStatus, project);
  options.prompter.log.info(describeChannelSetupEnvironment(environment));
  const result = await integration.setup({
    environment,
    state: {
      ...createDefaultSetupState(),
      project,
      projectPath: { kind: "resolved", inPlace: true, path: options.appRoot },
    },
    ui: createChannelSetupUi({
      asker: interactiveAsker(options.prompter),
      prompter: options.prompter,
    }),
    presetCreateSlackbot: options.yes ? true : undefined,
    skipDependencyMutation: true,
    deps: deps.addChannelsDeps,
    signal: options.signal,
  });
  return result.kind === "cancelled" ? result : { kind: "done" };
}
