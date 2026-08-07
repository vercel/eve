import { interactiveAsker } from "#setup/ask.js";
import { detectDeployment, projectResolutionFromDeployment } from "#setup/project-resolution.js";
import type { Prompter } from "#setup/prompter.js";
import { getVercelAuthStatus } from "#setup/vercel-project.js";

import {
  integrationSetupEnvironment,
  describeIntegrationSetupEnvironment,
} from "./shared/environment.js";
import { createIntegrationSetupUi } from "./shared/ui.js";
import { setupIntegration } from "./registry.js";
import type { IntegrationSetupResult } from "./types.js";

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
}

const defaultDeps: IntegrationSetupRunnerDeps = {
  detectDeployment,
  getVercelAuthStatus,
};

/** Runs one built-in integration setup flow selected by its registry setup name. */
export async function runIntegrationSetup(
  kind: string,
  options: RunIntegrationSetupOptions,
  deps: IntegrationSetupRunnerDeps = defaultDeps,
): Promise<IntegrationSetupResult> {
  const integration = setupIntegration(kind);
  options.prompter.intro(`Set up ${integration.label}`);
  options.prompter.log.message("Checking Vercel setup...");
  const [deployment, authStatus] = await Promise.all([
    deps.detectDeployment(options.appRoot, { signal: options.signal }),
    deps.getVercelAuthStatus(options.appRoot, { signal: options.signal }),
  ]);
  const project = projectResolutionFromDeployment(deployment);
  const environment = integrationSetupEnvironment(authStatus, project);
  options.prompter.log.info(describeIntegrationSetupEnvironment(environment));
  const context = {
    environment,
    appRoot: options.appRoot,
    ui: createIntegrationSetupUi({
      asker: interactiveAsker(options.prompter),
      prompter: options.prompter,
    }),
    yes: options.yes,
    signal: options.signal,
  };
  return integration.setup(context);
}
