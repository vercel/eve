import { createHeadlessPrompter } from "#setup/headless.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { mergeRegistrySetupCompletions } from "#setup/registry-setup-completion.js";
import type { RegistrySetupCompletion } from "#setup/registry-setup-protocol.js";

import type { RegistryCommandLogger, RegistrySetupDependencies } from "./registry.js";
import type { RegistrySetupCommand } from "./registry-setup-command.js";
import { headlessSetupContinuation, serializeHeadlessSetupEvent } from "./setup-headless.js";

export interface DeclaredSetupOptions {
  yes?: boolean;
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
  cancelledReminder: string;
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
      if (result.kind === "cancelled") {
        input.logger.log(input.cancelledReminder);
        return false;
      }
      if (result.kind === "blocked") {
        if (!input.options.nonInteractive) throw new Error("Setup requires more input.");
        input.logger.error(
          serializeHeadlessSetupEvent({
            version: 1,
            type: "blocked",
            item: input.item,
            installed: true,
            completedItems: [],
            ...result.blocker,
            next: headlessSetupContinuation({ item: input.item, installed: true }),
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
    const message = error instanceof Error ? error.message : String(error);
    if (input.options.nonInteractive) {
      input.logger.error(
        serializeHeadlessSetupEvent({
          version: 1,
          type: "failed",
          item: input.item,
          completedItems: [],
          message,
          next: headlessSetupContinuation({ item: input.item, installed: true }),
        }),
      );
      process.exitCode = 1;
      return false;
    }
    throw new Error(`${message} Try again with \`${input.resumeCommand}\`.`);
  }
}
