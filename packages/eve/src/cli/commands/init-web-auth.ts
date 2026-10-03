import { interactiveAsker } from "#setup/ask.js";
import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import { WEB_AUTHENTICATION_QUESTION } from "#setup/integrations/web/auth-options.js";
import { prepareWebAuthScaffold } from "#setup/integrations/web/auth-scaffold.js";
import { provisionWebChatAuth } from "#setup/integrations/web/provision-auth.js";
import { installScaffoldDependencies } from "#setup/integrations/shared/scaffold.js";
import { createPrompter } from "#setup/prompter.js";
import { readProjectLink } from "#setup/project-resolution.js";
import { WizardCancelledError } from "#setup/step.js";
import { withSpinner } from "#setup/with-spinner.js";

import type { InitCliLogger, InitCommandOptions } from "./init-agent-workspace.js";
import { runNonInteractiveLink } from "./vercel-non-interactive.js";

export interface InitWebAuthDeps {
  createPrompter: typeof createPrompter;
  ensureVercelProject: typeof ensureVercelProject;
  installScaffoldDependencies: typeof installScaffoldDependencies;
  prepareWebAuthScaffold: typeof prepareWebAuthScaffold;
  provisionWebChatAuth: typeof provisionWebChatAuth;
  readProjectLink: typeof readProjectLink;
  runNonInteractiveLink: typeof runNonInteractiveLink;
}

const defaultDeps: InitWebAuthDeps = {
  createPrompter,
  ensureVercelProject,
  installScaffoldDependencies,
  prepareWebAuthScaffold,
  provisionWebChatAuth,
  readProjectLink,
  runNonInteractiveLink,
};

/** Runs after the local app is installed, so a remote failure preserves a usable project. */
export async function runInitWebAuth(input: {
  appRoot: string;
  interactive: boolean;
  options: InitCommandOptions;
  logger: InitCliLogger;
  deps?: Partial<InitWebAuthDeps>;
}): Promise<void> {
  const deps = { ...defaultDeps, ...input.deps };
  const prompter = deps.createPrompter();
  const resume = `Web Chat was created at ${input.appRoot}. To finish sign-in setup, run \`eve link\` there if needed, then \`eve add channel/web --skip-install\`. Do not rerun eve init.`;
  try {
    const authentication =
      input.options.webAuthentication ??
      (input.interactive
        ? await interactiveAsker(prompter).ask(WEB_AUTHENTICATION_QUESTION)
        : "custom");
    if (authentication === "custom") {
      input.logger.log(
        "Web Chat uses the current channel auth. Configure authentication before deploying.",
      );
      return;
    }
    const writeAuth = await deps.prepareWebAuthScaffold({
      environmentRoot: input.appRoot,
      agentAppRoot: input.appRoot,
      webRoot: input.appRoot,
    });
    if (input.options.project !== undefined) {
      const linked = await deps.runNonInteractiveLink({
        logger: input.logger,
        appRoot: input.appRoot,
        options: { project: input.options.project, team: input.options.team, nonInteractive: true },
      });
      if (!linked) throw new Error("Vercel project linking did not complete.");
    }
    const project = input.interactive
      ? await deps.ensureVercelProject({ appRoot: input.appRoot, prompter })
      : await deps.readProjectLink(input.appRoot);
    if (project === undefined) {
      throw new Error(
        "Sign in with Vercel requires a linked project. Pass --project <name-or-id> (and --team <slug-or-id>) for non-interactive initialization.",
      );
    }
    await withSpinner(prompter, "Configuring Sign in with Vercel…", () =>
      deps.provisionWebChatAuth(project),
    );
    await writeAuth();
    await deps.installScaffoldDependencies({
      changed: true,
      log: prompter.log,
      projectPath: input.appRoot,
    });
    input.logger.log("Configured Sign in with Vercel for this project's team");
    input.logger.log(
      "Deploy the project to use Sign in with Vercel. Production and preview credentials are configured.",
    );
    input.logger.log("Local development continues to use localDev() without signing in.");
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      input.logger.log(resume);
      throw error;
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${resume}`, {
      cause: error,
    });
  }
}
