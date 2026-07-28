import type { Command } from "#compiled/commander/index.js";

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

  program
    .command("integration", { hidden: true })
    .command("setup <kind>")
    .option("-y, --yes")
    .action(async (kind: string, options: { yes?: boolean }) => {
      const { runIntegrationSetupCommand } = await import("./integration-setup.js");
      await runIntegrationSetupCommand(logger, appRoot, kind, { yes: options.yes });
    });
}
