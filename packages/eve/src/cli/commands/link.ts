import { isEveProject } from "#setup/scaffold/index.js";
import { runLinkFlow, type LinkFlowDeps } from "#setup/flows/link.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";

import { hasInteractiveTerminal, validateWorkspaceProjectCommand } from "./preconditions.js";
import {
  isNonInteractiveProjectCommand,
  runNonInteractiveLink,
  type NonInteractiveLinkDependencies,
  type VercelProjectCliOptions,
} from "./vercel-non-interactive.js";

export interface LinkCliLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface LinkCommandDependencies {
  createPrompter?: () => Prompter;
  hasInteractiveTerminal(): boolean;
  isEveProject?: typeof isEveProject;
  flowDeps?: Partial<LinkFlowDeps>;
  nonInteractiveLinkDeps?: NonInteractiveLinkDependencies;
}

const defaultDependencies: LinkCommandDependencies = {
  hasInteractiveTerminal,
  isEveProject,
};

export async function runLinkCommand(
  logger: LinkCliLogger,
  appRoot: string,
  dependencies: LinkCommandDependencies = defaultDependencies,
  options: VercelProjectCliOptions = {},
): Promise<void> {
  if (
    !(await validateWorkspaceProjectCommand({
      appRoot,
      isEveProject: dependencies.isEveProject,
      logger,
      workspaceMemberMessage: (workspace) =>
        `This agent belongs to the workspace at ${workspace.root}. Run \`eve link\` from the workspace root.`,
    }))
  ) {
    return;
  }
  if (isNonInteractiveProjectCommand(options)) {
    const prompter = dependencies.createPrompter?.() ?? createPrompter();
    await runNonInteractiveLink({
      logger,
      appRoot,
      options,
      prompter,
      dependencies: dependencies.nonInteractiveLinkDeps,
    });
    return;
  }
  if (!dependencies.hasInteractiveTerminal()) {
    logger.error(
      "`eve link` needs an interactive terminal to pick the team and project. Name the project instead: `eve link --project <name-or-id> --non-interactive`.",
    );
    process.exitCode = 1;
    return;
  }

  const prompter = dependencies.createPrompter?.() ?? createPrompter();
  prompter.intro("Link your eve agent to Vercel");
  try {
    const result = await runLinkFlow({
      appRoot,
      prompter,
      projectSelection: "create-or-link",
      deps: dependencies.flowDeps,
    });
    prompter.outro(result.kind === "cancelled" ? "Cancelled." : "Project linked.");
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
