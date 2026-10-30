import { createHeadlessPrompter } from "#setup/headless.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";
import { mergeRegistrySetupCompletions } from "#setup/registry-setup-completion.js";
import type { RegistrySetupCompletion } from "#setup/registry-setup-protocol.js";
import {
  SetupPrerequisiteRequired,
  setupPrerequisiteOf,
  type SetupPrerequisite,
} from "#setup/integrations/shared/prerequisite.js";

import type { RegistryCommandLogger, RegistrySetupDependencies } from "./registry.js";
import type { RegistrySetupCommand } from "./registry-setup-command.js";
import { headlessSetupContinuation, serializeHeadlessSetupEvent } from "./setup-headless.js";

/**
 * A declared setup that failed after the item's source was installed. Keeps
 * the original error as `cause` so interactive callers can report the item as
 * installed-but-not-set-up and recover from a structured prerequisite (for
 * example `vercel login`) instead of parsing the message.
 */
export class RegistrySetupFailedError extends Error {
  readonly item: string;
  readonly resumeCommand: string;
  /** The failure without the resume hint, for callers that render it separately. */
  readonly reason: string;

  constructor(input: { item: string; resumeCommand: string; cause: unknown }) {
    const reason = input.cause instanceof Error ? input.cause.message : String(input.cause);
    super(`${reason} Try again with \`${input.resumeCommand}\`.`, { cause: input.cause });
    this.name = "RegistrySetupFailedError";
    this.item = input.item;
    this.resumeCommand = input.resumeCommand;
    this.reason = reason;
  }

  get prerequisite(): SetupPrerequisite | undefined {
    return setupPrerequisiteOf(this.cause);
  }
}

interface DeclaredSetupOptions {
  yes?: boolean;
  force?: boolean;
  nonInteractive?: boolean;
  answers?: Record<string, unknown>;
  silent?: boolean;
  prompter?: Prompter;
  signal?: AbortSignal;
}

/** Runs and combines the setup commands declared by one registry item. */
export async function runDeclaredSetups(input: {
  logger: RegistryCommandLogger;
  appRoot: string;
  item: string;
  setups: readonly RegistrySetupCommand[] | undefined;
  options: DeclaredSetupOptions;
  dependencies: RegistrySetupDependencies;
  resumeCommand: string;
}): Promise<RegistrySetupCompletion | false> {
  let completion: RegistrySetupCompletion = { facts: [] };
  if (input.setups === undefined) return completion;
  const runSetupCommand = await input.dependencies.loadSetupCommandRunner();
  const prompter =
    input.options.prompter ??
    (input.options.nonInteractive ? createHeadlessPrompter(input.logger.log) : createPrompter());
  try {
    for (const setup of input.setups) {
      const result = await runSetupCommand(
        input.appRoot,
        {
          ...setup,
          args: [
            ...setup.args,
            ...(input.options.yes ? ["--yes"] : []),
            ...(input.options.force &&
            setup.package === "eve" &&
            setup.bin === "eve" &&
            setup.args[0] === "integration" &&
            setup.args[1] === "setup"
              ? ["--force"]
              : []),
            ...(input.options.nonInteractive ? ["--non-interactive"] : []),
            ...Object.entries(input.options.answers ?? {}).flatMap(([key, value]) => [
              "--answer",
              `${key}=${JSON.stringify(value)}`,
            ]),
          ],
        },
        input.item,
        { prompter, signal: input.options.signal },
      );
      if (result.kind === "cancelled") return false;
      if (result.kind === "blocked") {
        if (!input.options.nonInteractive) {
          if (result.blocker.status === "prerequisite_required") {
            throw new SetupPrerequisiteRequired(result.blocker.prerequisite);
          }
          throw new Error("Setup requires more input.");
        }
        input.logger.error(
          serializeHeadlessSetupEvent({
            version: 1,
            type: "blocked",
            item: input.item,
            installed: true,
            completedItems: [],
            ...result.blocker,
            next: headlessSetupContinuation({
              item: input.item,
              installed: true,
              answers: input.options.answers,
              question:
                result.blocker.status === "input_required" ? result.blocker.question : undefined,
            }),
          }),
        );
        process.exitCode = 2;
        return false;
      }
      if (input.options.silent !== true)
        for (const fact of result.facts) input.logger.log(`${fact.label}: ${fact.value}`);
      completion = mergeRegistrySetupCompletions(completion, result);
    }
    return completion;
  } catch (error) {
    if (error instanceof WizardCancelledError) return false;
    const message = error instanceof Error ? error.message : String(error);
    if (input.options.nonInteractive) {
      input.logger.error(
        serializeHeadlessSetupEvent({
          version: 1,
          type: "failed",
          item: input.item,
          completedItems: [],
          message,
          next: headlessSetupContinuation({
            item: input.item,
            installed: true,
            answers: input.options.answers,
          }),
        }),
      );
      process.exitCode = 1;
      return false;
    }
    throw new RegistrySetupFailedError({
      item: input.item,
      resumeCommand: input.resumeCommand,
      cause: error,
    });
  }
}
