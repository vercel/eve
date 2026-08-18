import { runLinkFlow, type LinkFlowDeps } from "#setup/flows/link.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";

import { hasInteractiveTerminal } from "./preconditions.js";
import {
  isNonInteractiveProjectCommand,
  runNonInteractiveLink,
  type VercelProjectCliOptions,
} from "./vercel-non-interactive.js";

export interface LinkCliLogger {
  error(message: string): void;
  log(message: string): void;
}

export interface LinkCommandDependencies {
  createPrompter?: () => Prompter;
  hasInteractiveTerminal(): boolean;
  /** Test seam into the flow's detection and box effects. */
  flowDeps?: Partial<LinkFlowDeps>;
}

const defaultDependencies: LinkCommandDependencies = {
  hasInteractiveTerminal,
};

/**
 * `eve link`: pick a Vercel team, then create or select a project (re-linking
 * when one is already linked), run `vercel link` for the resolved project,
 * then pull env so the AI Gateway credential lands in `.env.local`. The flow
 * itself is {@link runLinkFlow}, shared with the dev TUI `/model` menu's
 * provider row. Non-interactive callers name the Vercel project explicitly;
 * interactive callers use the eve-owned pickers.
 */
export async function runLinkCommand(
  logger: LinkCliLogger,
  appRoot: string,
  dependencies: LinkCommandDependencies = defaultDependencies,
  options: VercelProjectCliOptions = {},
): Promise<void> {
  if (isNonInteractiveProjectCommand(options)) {
    await runNonInteractiveLink({ logger, appRoot, options });
    return;
  }
  if (!dependencies.hasInteractiveTerminal()) {
    logger.error(
      "`eve link` needs an interactive terminal to pick the team and project. In CI, run `vercel link --project <name> --yes --non-interactive` instead.",
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
