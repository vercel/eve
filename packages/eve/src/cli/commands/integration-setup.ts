import {
  headlessAsker,
  InteractionRequired,
  interactiveAsker,
  InvalidAnswerError,
  withAnswers,
  withPolicy,
} from "#setup/ask.js";
import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import { createHeadlessPrompter } from "#setup/headless.js";
import { SetupPrerequisiteRequired } from "#setup/integrations/shared/prerequisite.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { createRegistrySetupClient, type SetupProcess } from "#setup/registry-setup-client.js";
import {
  runIntegrationSetup,
  type IntegrationSetupRunnerDeps,
} from "#setup/integrations/runner.js";
import { isEveProject } from "#setup/scaffold/index.js";
import { setupQuestionToWire } from "#setup/setup-question-wire.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";
import type { RegistryCommandLogger } from "./registry.js";
import { serializeHeadlessSetupEvent } from "./setup-headless.js";

export interface IntegrationSetupOptions {
  yes?: boolean;
  nonInteractive?: boolean;
  answers?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface IntegrationSetupDependencies {
  createPrompter?: () => Prompter;
  runnerDeps?: IntegrationSetupRunnerDeps;
  setupProcess?: SetupProcess;
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

  const client = createRegistrySetupClient({
    process: dependencies.setupProcess,
    signal: options.signal,
  });
  try {
    const nonInteractive = options.nonInteractive === true;
    const prompter =
      client?.prompter ??
      dependencies.createPrompter?.() ??
      (nonInteractive ? createHeadlessPrompter(() => {}) : createPrompter());
    const base = nonInteractive ? headlessAsker() : interactiveAsker(prompter);
    const policy = options.yes ? withPolicy("assume")(base) : base;
    const asker = withAnswers(options.answers ?? {})(policy);
    const result = await runIntegrationSetup(
      kind,
      {
        appRoot,
        prompter,
        asker,
        resolveVercelProject: nonInteractive
          ? undefined
          : () =>
              ensureVercelProject({
                appRoot,
                prompter,
                signal: client?.signal ?? options.signal,
              }),
        signal: client?.signal ?? options.signal,
        onExternalAction: nonInteractive
          ? (action) => {
              const id = `external-action-${crypto.randomUUID()}`;
              logger.log(
                serializeHeadlessSetupEvent({
                  version: 1,
                  type: "external_action",
                  id,
                  blocking: true,
                  ...action,
                }),
              );
              return {
                resolve() {
                  logger.log(
                    serializeHeadlessSetupEvent({
                      version: 1,
                      type: "external_action_resolved",
                      id,
                    }),
                  );
                },
              };
            }
          : undefined,
      },
      dependencies.runnerDeps,
    );
    if (result.kind === "cancelled") {
      client?.cancel();
      if (process.env.EVE_SETUP === "1") process.exitCode = 130;
      else if (nonInteractive)
        logger.error(serializeHeadlessSetupEvent({ version: 1, type: "cancelled", item: kind }));
      return;
    }
    prompter.outro("Integration set up.");
    client?.complete(result.completion);
    if (nonInteractive && client === undefined) {
      logger.log(serializeHeadlessSetupEvent({ version: 1, type: "completed", item: kind }));
    }
  } catch (error) {
    client?.fail(error);
    if (client !== undefined) return;
    if (options.nonInteractive && error instanceof InteractionRequired) {
      logger.error(
        serializeHeadlessSetupEvent({
          version: 1,
          type: "blocked",
          status: "input_required",
          question: setupQuestionToWire(error.question),
        }),
      );
      process.exitCode = 2;
    } else if (options.nonInteractive && error instanceof InvalidAnswerError) {
      logger.error(
        serializeHeadlessSetupEvent({
          version: 1,
          type: "blocked",
          status: "input_required",
          question: setupQuestionToWire(error.question),
          issue: { code: "invalid_answer", message: error.message },
        }),
      );
      process.exitCode = 2;
    } else if (options.nonInteractive && error instanceof SetupPrerequisiteRequired) {
      logger.error(
        serializeHeadlessSetupEvent({
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
