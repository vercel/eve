import { createPrompter, type Prompter } from "#setup/prompter.js";
import { mergeRegistrySetupCompletions } from "#setup/registry-setup-completion.js";
import type { RegistrySetupCompletion } from "#setup/registry-setup-protocol.js";

import type { RegistryCommandLogger, RegistrySetupDependencies } from "./registry.js";
import type { RegistrySetupCommand } from "./registry-setup-command.js";

export interface DeclaredSetupOptions {
  yes?: boolean;
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
  const prompter = input.options.prompter ?? createPrompter();
  try {
    for (const setup of input.setups) {
      const result = await runSetupCommand(
        input.appRoot,
        { ...setup, args: [...setup.args, ...(input.options.yes ? ["--yes"] : [])] },
        input.item,
        { prompter, signal: input.options.signal },
      );
      if (result.kind === "cancelled") {
        input.logger.log(input.cancelledReminder);
        return false;
      }
      if (input.options.silent !== true) {
        for (const fact of result.facts) input.logger.log(`${fact.label}: ${fact.value}`);
      }
      completion = mergeRegistrySetupCompletions(completion, result);
    }
    return completion;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} Try again with \`${input.resumeCommand}\`.`);
  }
}
