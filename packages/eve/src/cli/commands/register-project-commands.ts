import type { Command } from "#compiled/commander/index.js";
import { applicationCommand, type CliApplicationContext } from "#cli/application-command.js";

interface ProjectCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

/** Registers project-level Vercel commands without eagerly loading their flows. */
export function registerProjectCommands(input: {
  program: Command;
  logger: ProjectCommandLogger;
  applicationContext: CliApplicationContext;
}): void {
  applicationCommand(input.program.command("link"), input.applicationContext)
    .description("Link this directory to a Vercel project and pull AI Gateway credentials.")
    .action(async () => {
      const { runLinkCommand } = await import("./link.js");
      await runLinkCommand(input.logger, input.applicationContext.root);
    });

  applicationCommand(input.program.command("deploy"), input.applicationContext)
    .description("Deploy the agent to Vercel production (links first if needed).")
    .action(async () => {
      const { runDeployCommand } = await import("./deploy.js");
      await runDeployCommand(input.logger, input.applicationContext.root);
    });
}
