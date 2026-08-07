import { headlessAsker, interactiveAsker, withAnswers, type Asker } from "#setup/ask.js";
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
   * Prefer the headless Asker base so required decisions refuse with
   * {@link import("#setup/ask.js").InteractionRequired} instead of prompting.
   * Pair with {@link answers} for agent/flag-driven runs.
   */
  headless?: boolean;
  /** Pre-answers keyed by question `key` (flags, agent tool args). */
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

/**
 * Composes the Asker stack for one integration setup run. Interactive default
 * matches today's CLI; headless uses {@link headlessAsker} so missing required
 * keys refuse structurally. Optional {@link withAnswers} sits outside either base.
 */
export function composeIntegrationAsker(options: {
  prompter: Prompter;
  headless?: boolean;
  answers?: Record<string, unknown>;
}): Asker {
  const base = options.headless ? headlessAsker() : interactiveAsker(options.prompter);
  return options.answers === undefined ? base : withAnswers(options.answers)(base);
}

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
  const result = await integration.setup({
    environment,
    appRoot: options.appRoot,
    ui: createIntegrationSetupUi({
      asker: composeIntegrationAsker({
        prompter: options.prompter,
        headless: options.headless,
        answers: options.answers,
      }),
      prompter: options.prompter,
    }),
    yes: options.yes,
    headless: options.headless,
    signal: options.signal,
  });
  return result;
}
