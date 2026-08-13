import type { Command } from "#compiled/commander/index.js";

export interface CliApplicationContext {
  root: string;
  resolve(): Promise<void>;
}

export type CliApplicationRootRequirement = (command: Command) => boolean;

/** Adds application-root resolution to a project-scoped CLI command. */
export function applicationCommand(
  command: Command,
  applicationContext: CliApplicationContext,
  requirement: CliApplicationRootRequirement = () => true,
): Command {
  return command.hook("preAction", async (_command, actionCommand) => {
    if (requirement(actionCommand)) await applicationContext.resolve();
  });
}
