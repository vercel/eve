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
    .option("--non-interactive", "Run without interactive prompts")
    .option("--project <name-or-id>", "Vercel project name or ID")
    .option("--team <team-id-or-slug>", "Vercel team ID or slug")
    .action(async (options: { nonInteractive?: boolean; project?: string; team?: string }) => {
      const { runLinkCommand } = await import("./link.js");
      await runLinkCommand(input.logger, input.applicationContext.root, undefined, options);
    });

  applicationCommand(input.program.command("deploy"), input.applicationContext)
    .description("Deploy the agent to Vercel production (links first if needed).")
    .option("--non-interactive", "Run without interactive prompts")
    .option("--project <name-or-id>", "Vercel project name or ID")
    .option("--team <team-id-or-slug>", "Vercel team ID or slug")
    .option("-y, --yes", "Confirm a non-interactive production deployment")
    .action(
      async (options: {
        nonInteractive?: boolean;
        project?: string;
        team?: string;
        yes?: boolean;
      }) => {
        const { runDeployCommand } = await import("./deploy.js");
        await runDeployCommand(input.logger, input.applicationContext.root, undefined, options);
      },
    );
}
