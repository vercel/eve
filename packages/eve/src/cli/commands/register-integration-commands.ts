import type { Command } from "#compiled/commander/index.js";
import { applicationCommand, type CliApplicationContext } from "#cli/application-command.js";

import { parseSetupAnswer } from "./setup-answers.js";

interface IntegrationCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

/** Registers hidden built-in integration setup commands used by trusted registry items. */
export function registerIntegrationCommands(input: {
  program: Command;
  logger: IntegrationCommandLogger;
  applicationContext: CliApplicationContext;
}): void {
  const { applicationContext, logger, program } = input;

  const integration = program.command("integration", { hidden: true });

  applicationCommand(integration.command("setup <kind>"), applicationContext)
    .option("-y, --yes")
    .option(
      "--non-interactive",
      "Run without interactive prompts, instead emit structured NDJSON when further input is required",
    )
    .option(
      "--answer <key=value>",
      "Answer a setup question; requires --non-interactive.",
      parseSetupAnswer,
      {},
    )
    .action(
      async (
        kind: string,
        options: {
          yes?: boolean;
          nonInteractive?: boolean;
          answer?: Record<string, unknown>;
        },
      ) => {
        const { runIntegrationSetupCommand } = await import("./integration-setup.js");
        await runIntegrationSetupCommand(logger, applicationContext.root, kind, {
          yes: options.yes,
          nonInteractive: options.nonInteractive,
          answers: options.answer,
        });
      },
    );

  applicationCommand(
    integration.command("connect <slug> <service> [canonical-name]"),
    applicationContext,
  )
    .option("-y, --yes")
    .option(
      "--non-interactive",
      "Run without interactive prompts, instead emit structured NDJSON when further input is required",
    )
    .action(
      async (
        slug: string,
        service: string,
        canonicalName: string | undefined,
        options: { nonInteractive?: boolean },
      ) => {
        const { runIntegrationConnectCommand } = await import("./integration-connect.js");
        await runIntegrationConnectCommand(
          logger,
          applicationContext.root,
          slug,
          service,
          canonicalName,
          options,
        );
      },
    );
}
