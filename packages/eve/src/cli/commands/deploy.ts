import { isEveProject } from "#setup/scaffold/index.js";

import { runDeployFlow, type DeployFlowDeps } from "#setup/flows/deploy.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";

import { hasInteractiveTerminal, NOT_AN_AGENT_MESSAGE } from "./preconditions.js";

export interface DeployCliLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface DeployCommandDependencies {
  createPrompter?: () => Prompter;
  isEveProject(projectPath: string): Promise<boolean>;
  hasInteractiveTerminal(): boolean;
  /** Test seam into the flow's detection and box effects. */
  flowDeps?: Partial<DeployFlowDeps>;
}

const defaultDependencies: DeployCommandDependencies = {
  isEveProject,
  hasInteractiveTerminal,
};

/**
 * `eve deploy`: deploy the agent to Vercel production. An already-linked
 * project deploys straight away (interactively or not); an unlinked one walks
 * the same team/project pickers as onboarding when a terminal is present, and
 * refuses with `eve link` guidance otherwise. The flow itself is
 * {@link runDeployFlow}, shared with the dev TUI's `/deploy`.
 */
export async function runDeployCommand(
  logger: DeployCliLogger,
  appRoot: string,
  dependencies: DeployCommandDependencies = defaultDependencies,
): Promise<void> {
  if (!(await dependencies.isEveProject(appRoot))) {
    logger.error(NOT_AN_AGENT_MESSAGE);
    process.exitCode = 1;
    return;
  }

  const prompter = dependencies.createPrompter?.() ?? createPrompter();
  prompter.intro("Deploy your eve agent to Vercel");
  try {
    const result = await runDeployFlow({
      appRoot,
      prompter,
      interactive: dependencies.hasInteractiveTerminal(),
      deps: dependencies.flowDeps,
    });
    if (result.kind === "needs-link") {
      logger.error(
        "This directory is not linked to a Vercel project. Run `eve link` first (or `vercel link --project <name> --yes --non-interactive` in CI), then re-run `eve deploy`.",
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
