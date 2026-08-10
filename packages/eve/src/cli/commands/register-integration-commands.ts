import type { Command } from "#compiled/commander/index.js";

import { parseSetupAnswer } from "./setup-answers.js";

interface IntegrationCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

/** Registers hidden built-in integration setup commands used by trusted registry items. */
export function registerIntegrationCommands(input: {
  program: Command;
  logger: IntegrationCommandLogger;
  appRoot: string;
}): void {
  const { appRoot, logger, program } = input;

  const integration = program.command("integration", { hidden: true });

  integration
    .command("setup <kind>")
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
        await runIntegrationSetupCommand(logger, appRoot, kind, {
          yes: options.yes,
          nonInteractive: options.nonInteractive,
          answers: options.answer,
        });
      },
    );

  integration
    .command("connect <slug> <service> [canonical-name]")
    .option("-y, --yes")
    .action(async (slug: string, service: string, canonicalName: string | undefined) => {
      const { runIntegrationConnectCommand } = await import("./integration-connect.js");
      await runIntegrationConnectCommand(logger, appRoot, slug, service, canonicalName);
    });
}
