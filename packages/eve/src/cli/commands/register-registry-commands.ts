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
    .command("add <item>")
    .description("Install a registry item; relative paths use the official eve registry.")
    .option("-o, --overwrite", "Overwrite existing files.")
    .option("--skip-install", "Run the item's setup flow without installing it.")
    .option("--skip-setup", "Skip the item's setup flow.")
    .option("-y, --yes", "Run setup and accept its recommended defaults.")
    .action(
      async (
        item: string,
        options: { skipInstall?: boolean; overwrite?: boolean; skipSetup?: boolean; yes?: boolean },
      ) => {
        const { runAddCommand } = await import("./registry.js");
        await runAddCommand(logger, appRoot, item, options);
      },
    );

  const registry = program
    .command("registry")
    .description("Configure and browse extension and agent registry catalogs.");

  registry
    .command("add <registries...>")
    .description("Add registry namespace mappings to package.json.")
    .action(async (registries: string[]) => {
      const { runRegistryAddCommand } = await import("./registry.js");
      await runRegistryAddCommand(logger, appRoot, registries);
    });

  registry
    .command("list")
    .description("List items from all registries or one source.")
    .option("-r, --registry <source>", "List items from one registry.")
    .action(async (options: { registry?: string }) => {
      const { runRegistryListCommand } = await import("./registry.js");
      await runRegistryListCommand(logger, appRoot, options.registry);
    });

  registry
    .command("search <query>")
    .description("Search all registries or one source.")
    .option("-r, --registry <source>", "Search one registry.")
    .action(async (query: string, options: { registry?: string }) => {
      const { runRegistrySearchCommand } = await import("./registry.js");
      await runRegistrySearchCommand(logger, appRoot, query, options.registry);
    });

  registry
    .command("view <item>")
    .description("Print one registry item as JSON.")
    .action(async (item: string) => {
      const { runRegistryViewCommand } = await import("./registry.js");
      await runRegistryViewCommand(logger, appRoot, item);
    });
}
