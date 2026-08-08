import { headlessAsker, interactiveAsker, withAnswers } from "#setup/ask.js";
import type { RegistrySetupFact } from "#setup/registry-setup-protocol.js";
import { detectDeployment, projectResolutionFromDeployment } from "#setup/project-resolution.js";
import type { Prompter } from "#setup/prompter.js";
import { getVercelAuthStatus } from "#setup/vercel-project.js";

import {
  integrationSetupEnvironment,
  describeIntegrationSetupEnvironment,
} from "./shared/environment.js";
import { createIntegrationSetupUi } from "./shared/ui.js";
import { setupIntegration } from "./registry.js";

/** Inputs shared by every registry-owned integration setup flow. */
export interface RunIntegrationSetupOptions {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  yes?: boolean;
  /**
   * Headless runs supply pre-answered questions by stable key. Setting this
   * makes the run headless: unmatched non-required questions skip, required
   * ones refuse with InteractionRequired, and the context carries `headless`
   * so one-time interactive prerequisites stay out of the run.
   */
  answers?: Record<string, unknown>;
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
  const environment = integrationSetupEnvironment(authStatus, project);
  options.prompter.log.info(describeIntegrationSetupEnvironment(environment));
  // Headless runs (answers supplied) swap the terminal for the keyed answer
  // ladder: supplied answers win; the rest skips when non-required and
  // refuses with InteractionRequired when required.
  const headless = options.answers !== undefined;
  const asker = headless
    ? withAnswers(options.answers ?? {})(headlessAsker())
    : interactiveAsker(options.prompter);
  const result = await integration.setup({
    environment,
    appRoot: options.appRoot,
    ui: createIntegrationSetupUi({ asker, prompter: options.prompter }),
    yes: options.yes,
    signal: options.signal,
    headless,
  });
  return result;
}
