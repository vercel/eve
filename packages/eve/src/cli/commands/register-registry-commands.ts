import { InvalidArgumentError, type Command } from "#compiled/commander/index.js";
import { applicationCommand, type CliApplicationContext } from "#cli/application-command.js";

import { parseSetupAnswer } from "./setup-answers.js";

interface RegistryCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;

function parseSearchLimit(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError(`Expected a positive integer, received "${value}".`);
  }

  const limit = Number(value);
  if (limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new InvalidArgumentError(
      `Expected a limit between 1 and ${MAX_SEARCH_LIMIT}, received "${value}".`,
    );
  }
  return limit;
}

/** Registers registry installation, configuration, and discovery commands. */
export function registerRegistryCommands(input: {
  program: Command;
  logger: RegistryCommandLogger;
  applicationContext: CliApplicationContext;
}): void {
  const { applicationContext, logger, program } = input;

  applicationCommand(program.command("add <item>"), applicationContext)
    .description("Install a registry item; relative paths use the official eve registry.")
    .option("-o, --overwrite", "Overwrite existing files.")
    .option("--skip-install", "Run the item's setup flow without installing it.")
    .option("--skip-setup", "Skip the item's setup flow.")
    .option(
      "--non-interactive",
      "Run without interactive prompts, instead emit structured NDJSON when further input is required",
    )
    .option(
      "--answer <key=value>",
      "Answer a setup question with JSON; requires --non-interactive; repeat for multiple answers.",
      parseSetupAnswer,
    )
    .option("-y, --yes", "Run setup and accept its recommended defaults.")
    .action(
      async (
        item: string,
        options: {
          skipInstall?: boolean;
          overwrite?: boolean;
          skipSetup?: boolean;
          nonInteractive?: boolean;
          answer?: Record<string, unknown>;
          yes?: boolean;
        },
      ) => {
        if (options.answer !== undefined && !options.nonInteractive) {
          throw new InvalidArgumentError("--answer requires --non-interactive.");
        }
        const { runAddCommand } = await import("./registry.js");
        await runAddCommand(logger, applicationContext.root, item, {
          ...options,
          answers: options.answer,
        });
      },
    );

  const registry = program
    .command("registry")
    .description("Configure and browse extension and agent registry catalogs.");

  applicationCommand(registry.command("add <registries...>"), applicationContext)
    .description("Add registry namespace mappings to package.json.")
    .action(async (registries: string[]) => {
      const { runRegistryAddCommand } = await import("./registry.js");
      await runRegistryAddCommand(logger, applicationContext.root, registries);
    });

  applicationCommand(registry.command("list"), applicationContext)
    .description("List items from all registries or one source.")
    .option("-r, --registry <source>", "List items from one registry.")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean; registry?: string }) => {
      const { runRegistryListCommand } = await import("./registry.js");
      await runRegistryListCommand(logger, applicationContext.root, options.registry, options);
    });

  applicationCommand(registry.command("search <query>"), applicationContext)
    .description("Search all registries or one source.")
    .option("-r, --registry <source>", "Search one registry.")
    .option(
      "--limit <count>",
      `Maximum results to return (default: ${DEFAULT_SEARCH_LIMIT}).`,
      parseSearchLimit,
      DEFAULT_SEARCH_LIMIT,
    )
    .option("--json", "Output as JSON")
    .action(
      async (query: string, options: { json?: boolean; limit: number; registry?: string }) => {
        const { runRegistrySearchCommand } = await import("./registry.js");
        await runRegistrySearchCommand(
          logger,
          applicationContext.root,
          query,
          options.registry,
          options,
        );
      },
    );

  applicationCommand(registry.command("view <item>"), applicationContext)
    .description("Inspect one registry item.")
    .option("--json", "Output the raw registry item as JSON.")
    .action(async (item: string, options: { json?: boolean }) => {
      const { runRegistryViewCommand } = await import("./registry.js");
      await runRegistryViewCommand(logger, applicationContext.root, item, options);
    });
}
