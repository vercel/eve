import type { Command } from "#compiled/commander/index.js";

export interface CliApplicationContext {
  root: string;
}

export type CliApplicationRootRequirement = (command: Command) => boolean;

const applicationRootRequirement = new WeakMap<Command, CliApplicationRootRequirement>();

/** Marks a CLI command as requiring a resolved eve application root. */
export function applicationCommand(
  command: Command,
  requirement: CliApplicationRootRequirement = () => true,
): Command {
  applicationRootRequirement.set(command, requirement);
  return command;
}

export function commandRequiresApplicationRoot(command: Command): boolean {
  return applicationRootRequirement.get(command)?.(command) ?? false;
}
