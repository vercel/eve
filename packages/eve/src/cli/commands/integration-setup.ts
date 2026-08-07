import {
  headlessAsker,
  InteractionRequired,
  InvalidAnswerError,
  withAnswers,
  withPolicy,
} from "#setup/ask.js";
import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import { createHeadlessPrompter } from "#setup/headless.js";
import { SetupPrerequisiteRequired } from "#setup/integrations/shared/prerequisite.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { createRegistrySetupClient } from "#setup/registry-setup-client.js";
import {
  runIntegrationSetup,
  type IntegrationSetupRunnerDeps,
} from "#setup/integrations/runner.js";
import { isEveProject } from "#setup/scaffold/index.js";
import { setupQuestionToWire } from "#setup/setup-question-wire.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";
import type { RegistryCommandLogger } from "./registry.js";

export interface IntegrationSetupOptions {
  yes?: boolean;
  headless?: boolean;
  answers?: Record<string, unknown>;
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
    const headless = options.headless === true;
    const prompter =
      client?.prompter ??
      dependencies.createPrompter?.() ??
      (headless ? createHeadlessPrompter(() => {}) : createPrompter());
    const base = headlessAsker();
    const asker = headless
      ? withAnswers(options.answers ?? {})(options.yes ? withPolicy("assume")(base) : base)
      : undefined;
    const result = await runIntegrationSetup(
      kind,
      {
        appRoot,
        prompter,
        asker,
        resolveVercelProject: headless
          ? undefined
          : () =>
              ensureVercelProject({
                appRoot,
                prompter,
                signal: client?.signal ?? options.signal,
              }),
        signal: client?.signal ?? options.signal,
        onExternalAction: headless
          ? (action) =>
              logger.log(JSON.stringify({ version: 1, type: "external_action", ...action }))
          : undefined,
      },
      dependencies.runnerDeps,
    );
    if (result.kind === "cancelled") {
      client?.cancel();
      if (process.env.EVE_SETUP === "1") process.exitCode = 130;
      else if (headless)
        logger.error(JSON.stringify({ version: 1, type: "cancelled", item: kind }));
      return;
    }
    prompter.outro("Integration set up.");
    client?.complete(result.completion);
    if (headless && client === undefined) {
      logger.log(JSON.stringify({ version: 1, type: "completed", item: kind }));
    }
  } catch (error) {
    client?.fail(error);
    if (options.headless && error instanceof InteractionRequired) {
      logger.error(
        JSON.stringify({
          version: 1,
          type: "blocked",
          status: "input_required",
          question: setupQuestionToWire(error.question),
        }),
      );
      process.exitCode = 2;
    } else if (options.headless && error instanceof InvalidAnswerError) {
      logger.error(
        JSON.stringify({
          version: 1,
          type: "blocked",
          status: "input_required",
          question: setupQuestionToWire(error.question),
          issue: { code: "invalid_answer", message: error.message },
        }),
      );
      process.exitCode = 2;
    } else if (options.headless && error instanceof SetupPrerequisiteRequired) {
      logger.error(
        JSON.stringify({
          version: 1,
          type: "blocked",
          status: "prerequisite_required",
          prerequisite: error.prerequisite,
        }),
      );
      process.exitCode = 2;
    } else {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
