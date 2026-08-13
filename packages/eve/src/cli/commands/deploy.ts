import { resolveEveProjectContext } from "#internal/project-context.js";
import { isEveProject } from "#setup/scaffold/index.js";
import { runDeployFlow, type DeployFlowDeps } from "#setup/flows/deploy.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";

import { hasInteractiveTerminal, NOT_AN_AGENT_MESSAGE } from "./preconditions.js";
import {
  isNonInteractiveProjectCommand,
  runNonInteractiveLink,
  type VercelProjectCliOptions,
} from "./vercel-non-interactive.js";

export interface DeployCliLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface DeployCommandDependencies {
  createPrompter?: () => Prompter;
  hasInteractiveTerminal(): boolean;
  isEveProject: typeof isEveProject;
  /** Test seam into the flow's detection and box effects. */
  flowDeps?: Partial<DeployFlowDeps>;
}

const defaultDependencies: DeployCommandDependencies = {
  hasInteractiveTerminal,
  isEveProject,
};

/**
 * `eve deploy`: deploy the agent to Vercel production. An already-linked
 * project deploys straight away (interactively or not); an unlinked interactive
 * run walks the same team/project pickers as onboarding. A non-interactive
 * caller can name a project to link before deployment. The flow itself is
 * {@link runDeployFlow}, shared with the dev TUI's `/deploy`.
 */
export async function runDeployCommand(
  logger: DeployCliLogger,
  appRoot: string,
  dependencies: DeployCommandDependencies = defaultDependencies,
  options: VercelProjectCliOptions & { yes?: boolean } = {},
): Promise<void> {
  const projectContext = await resolveEveProjectContext(appRoot);
  if (projectContext.kind === "workspace-member") {
    logger.error(
      `This agent belongs to the workspace at ${projectContext.workspace.root}. Run \`eve deploy\` from the workspace root to deploy every peer agent together.`,
    );
    process.exitCode = 1;
    return;
  }
  if (!(await dependencies.isEveProject(appRoot)) && projectContext.kind === "standalone") {
    logger.error(NOT_AN_AGENT_MESSAGE);
    process.exitCode = 1;
    return;
  }
  if (isNonInteractiveProjectCommand(options)) {
    if (options.yes !== true) {
      logger.error(
        "`eve deploy --non-interactive` requires `--yes` to confirm production deployment.",
      );
      process.exitCode = 1;
      return;
    }
    if (options.project !== undefined) {
      if (!(await runNonInteractiveLink({ logger, appRoot, options }))) return;
    }
  }
  const prompter = dependencies.createPrompter?.() ?? createPrompter();
  prompter.intro("Deploy your eve agent to Vercel");
  try {
    const result = await runDeployFlow({
      appRoot,
      prompter,
      interactive: isNonInteractiveProjectCommand(options)
        ? false
        : dependencies.hasInteractiveTerminal(),
      deps: dependencies.flowDeps,
    });
    if (result.kind === "needs-link") {
      logger.error(
        "This directory is not linked to a Vercel project. Run `eve link` first, or name the project on the deploy itself: `eve deploy --project <name-or-id> --non-interactive --yes`.",
      );
      process.exitCode = 1;
      return;
    }
    if (result.kind === "local-model") {
      logger.error(
        "ChatGPT subscription models use local Codex credentials and cannot be deployed. Switch to an AI Gateway or server-authenticated model before running `eve deploy`.",
      );
      process.exitCode = 1;
      return;
    }
    prompter.outro(
      result.kind === "cancelled"
        ? "Cancelled."
        : result.productionUrl === undefined
          ? "Deployed."
          : `Deployed: ${result.productionUrl}`,
    );
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
