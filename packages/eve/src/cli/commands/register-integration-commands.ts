import { InvalidArgumentError, type Command } from "#compiled/commander/index.js";
import type { CliApplicationContext } from "#cli/application-command.js";
import { agentCommand } from "#cli/agent-command.js";
import type { ConnectPrincipalType } from "#setup/connection-connector.js";

import { parseSetupAnswer } from "./setup-answers.js";

interface IntegrationCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

export function parseConnectPrincipalType(value: string): ConnectPrincipalType {
  if (value === "app" || value === "user") return value;
  throw new InvalidArgumentError('Expected principal type "app" or "user".');
}

/** Registers built-in integration setup commands used by trusted registry items. */
export function registerIntegrationCommands(input: {
  program: Command;
  logger: IntegrationCommandLogger;
  applicationContext: CliApplicationContext;
}): void {
  const { applicationContext, logger, program } = input;

  const integration = program.command("integration").description("Set up an eve integration");

  agentCommand(integration.command("setup <kind>"), applicationContext)
    .description("Run a built-in integration setup flow")
    .option("-y, --yes")
    .option("--force", "Overwrite files created by setup.")
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
          force?: boolean;
          nonInteractive?: boolean;
          answer?: Record<string, unknown>;
        },
      ) => {
        const { runIntegrationSetupCommand } = await import("./integration-setup.js");
        await runIntegrationSetupCommand(logger, applicationContext.root, kind, {
          yes: options.yes,
          force: options.force,
          nonInteractive: options.nonInteractive,
          answers: options.answer,
        });
      },
    );

  agentCommand(
    integration.command("connect <slug> <service> [canonical-name]", { hidden: true }),
    applicationContext,
  )
    .option("-y, --yes")
    .option("--creation-type <type>", "Select the Vercel Connect creation type.")
    .option("--connection-method <method>", "Select the Vercel Connect connection method.")
    .option(
      "--principal-type <type>",
      "Require app- or user-scoped Vercel Connect credentials.",
      parseConnectPrincipalType,
    )
    .option(
      "--non-interactive",
      "Run without interactive prompts, instead emit structured NDJSON when further input is required",
    )
    .action(
      async (
        slug: string,
        service: string,
        canonicalName: string | undefined,
        options: {
          creationType?: string;
          connectionMethod?: "mcp" | "oauth";
          principalType?: ConnectPrincipalType;
          nonInteractive?: boolean;
        },
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
