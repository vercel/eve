import { isEveProject } from "#setup/scaffold/index.js";
import { runDeployFlow, type DeployFlowDeps } from "#setup/flows/deploy.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { configureTraceSampling } from "#setup/vercel-trace-sampling.js";

import { hasInteractiveTerminal, validateWorkspaceProjectCommand } from "./preconditions.js";
import {
  isNonInteractiveProjectCommand,
  runNonInteractiveLink,
  type NonInteractiveLinkDependencies,
  type VercelProjectCliOptions,
} from "./vercel-non-interactive.js";

export interface DeployCliLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface DeployCommandDependencies {
  createPrompter?: () => Prompter;
  hasInteractiveTerminal(): boolean;
  isEveProject?: typeof isEveProject;
  /** Test seam into the flow's detection and box effects. */
  flowDeps?: Partial<DeployFlowDeps>;
  nonInteractiveLinkDeps?: NonInteractiveLinkDependencies;
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
  options: VercelProjectCliOptions & { yes?: boolean; traceSampling?: boolean } = {},
): Promise<void> {
  if (
    !(await validateWorkspaceProjectCommand({
      appRoot,
      isEveProject: dependencies.isEveProject,
      logger,
      workspaceMemberMessage: (workspace) =>
        `This agent belongs to the workspace at ${workspace.root}. Run \`eve deploy\` from the workspace root to deploy every peer agent together.`,
    }))
  ) {
    return;
  }
  const nonInteractive = isNonInteractiveProjectCommand(options);
  if (nonInteractive && options.yes !== true) {
    logger.error(
      "`eve deploy --non-interactive` requires `--yes` to confirm production deployment.",
    );
    process.exitCode = 1;
    return;
  }
  const prompter = dependencies.createPrompter?.() ?? createPrompter();
  try {
    if (nonInteractive && options.project !== undefined) {
      if (
        !(await runNonInteractiveLink({
          logger,
          appRoot,
          options,
          dependencies: dependencies.nonInteractiveLinkDeps,
          onCreatedProject:
            options.traceSampling === false
              ? undefined
              : (link) => configureTraceSampling(link, appRoot, prompter),
          onProjectCreationUnknown:
            options.traceSampling === false
              ? undefined
              : () =>
                  prompter.log.warning(
                    "Could not verify the Vercel project for trace sampling, so it was not configured. Check the project settings if you need traces in Agent Runs.",
                  ),
        }))
      )
        return;
    }
    prompter.intro("Deploy your eve agent to Vercel");
    const result = await runDeployFlow({
      appRoot,
      prompter,
      traceSampling: options.traceSampling !== false,
      interactive: nonInteractive ? false : dependencies.hasInteractiveTerminal(),
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
        "ChatGPT subscription models use local ChatGPT credentials and cannot be deployed. Switch to an AI Gateway or server-authenticated model before running `eve deploy`.",
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
