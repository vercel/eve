import type { Command } from "#compiled/commander/index.js";
import type { CliApplicationContext } from "#cli/application-command.js";
import { findEveProjectContext } from "#internal/project-context.js";

interface ProjectCommandLogger {
  error(message: string): void;
  log(message: string): void;
}

/**
 * Resolves standalone projects without using application discovery, which
 * deliberately selects an individual agent and cannot represent a workspace
 * root. Workspace members remain unchanged so the command can explain that
 * deployment and linking belong at the workspace root.
 */
function projectCommand(command: Command, applicationContext: CliApplicationContext): Command {
  return command.hook("preAction", async () => {
    const context = await findEveProjectContext(applicationContext.root);
    if (context?.kind === "standalone") applicationContext.root = context.appRoot;
  });
}

/** Registers project-level Vercel commands without eagerly loading their flows. */
export function registerProjectCommands(input: {
  program: Command;
  logger: ProjectCommandLogger;
  applicationContext: CliApplicationContext;
}): void {
  projectCommand(input.program.command("link"), input.applicationContext)
    .description("Link this directory to a Vercel project and pull AI Gateway credentials.")
    .option("--non-interactive", "Run without interactive prompts")
    .option("--project <name-or-id>", "Vercel project name or ID")
    .option("--team <team-id-or-slug>", "Vercel team ID or slug")
    .action(async (options: { nonInteractive?: boolean; project?: string; team?: string }) => {
      const { runLinkCommand } = await import("./link.js");
      await runLinkCommand(input.logger, input.applicationContext.root, undefined, options);
    });

  projectCommand(input.program.command("deploy"), input.applicationContext)
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
