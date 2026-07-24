import type { Command } from "#compiled/commander/index.js";

interface RegistryCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

/** Registers registry installation, configuration, and discovery commands. */
export function registerRegistryCommands(input: {
  program: Command;
  logger: RegistryCommandLogger;
  appRoot: string;
}): void {
  const { appRoot, logger, program } = input;

  program
    .command("add <item> [flags...]")
    .description("Install a registry item; bare slugs use the official eve registry.")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (item: string, flags: string[]) => {
      const { runAddCommand } = await import("./extensions.js");
      await runAddCommand(logger, appRoot, item, flags);
    });

  const registry = program
    .command("registry")
    .description("Browse extension and agent registry catalogs.");

  for (const command of ["add", "remove", "sources", "list", "search", "view"] as const) {
    registry
      .command(`${command} [arguments...]`)
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .action(async (arguments_: string[]) => {
        if (command === "add" || command === "remove" || command === "sources") {
          const { runRegistryConfigurationCommand } = await import("./extensions.js");
          await runRegistryConfigurationCommand(logger, appRoot, [command, ...arguments_]);
          return;
        }
        const { runRegistryBrowseCommand } = await import("./extensions.js");
        await runRegistryBrowseCommand(logger, appRoot, command, arguments_);
      });
  }
}
