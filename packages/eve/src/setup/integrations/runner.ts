import { interactiveAsker, type Asker } from "#setup/ask.js";
import {
  detectDeployment,
  projectResolutionFromDeployment,
  type VercelProjectReference,
} from "#setup/project-resolution.js";
import type { Prompter } from "#setup/prompter.js";
import { getVercelAuthStatus } from "#setup/vercel-project.js";

import {
  integrationSetupEnvironment,
  describeIntegrationSetupEnvironment,
} from "./shared/environment.js";
import { resolveIntegrationVercelProject } from "./shared/vercel-project.js";
import { createSetupContexts } from "./shared/ui.js";
import { setupIntegration } from "./registry.js";
import type { IntegrationSetupResult } from "./types.js";

/** Inputs shared by every registry-owned integration setup flow. */
export interface RunIntegrationSetupOptions {
  appRoot: string;
  prompter: Prompter;
  /** Defaults to the interactive adapter; agent drivers inject an answer-backed asker. */
  asker?: Asker;
  signal?: AbortSignal;
  force?: boolean;
  onExternalAction?: (input: { url: string; userCode?: string; message: string }) => void;
  resolveVercelProject?: SetupProjectResolver;
}

/** Effects shared by the built-in integration setup runner. */
export type SetupProjectResolver = (integration: string) => Promise<VercelProjectReference>;

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
  return integration.run(
    createSetupContexts({
      appRoot: options.appRoot,
      asker: options.asker ?? interactiveAsker(options.prompter),
      environment,
      prompter: options.prompter,
      resolveVercelProject:
        options.resolveVercelProject ??
        ((integration) =>
          resolveIntegrationVercelProject({
            appRoot: options.appRoot,
            integration,
            signal: options.signal,
          })),
      signal: options.signal,
      force: options.force,
      onExternalAction: options.onExternalAction,
    }),
  );
}
