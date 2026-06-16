import { createPromptCommandOutput, withPhase, type ChannelSetupLog } from "#setup/cli/index.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import { detectPackageManager } from "#setup/package-manager.js";
import { runPackageManagerInstall } from "#setup/primitives/pm/run.js";
import { runVercel } from "#setup/primitives/run-vercel.js";

import {
  detectDeployment,
  isProjectResolved,
  mergeProjectResolution,
  projectResolutionFromDeployment,
  projectResolutionFromDeployResult,
  type ProjectResolution,
} from "../project-resolution.js";
import { hasVercelProject, requireProjectPath, type SetupState } from "../state.js";
import type { SetupBox } from "../step.js";

const VERCEL_DEPLOY_ENV: Readonly<Record<string, string>> = {
  VERCEL_USE_EXPERIMENTAL_FRAMEWORKS: "1",
};

/** Injected for tests; defaults to the real subprocess primitives. */
export interface DeployProjectDeps {
  runVercel: typeof runVercel;
  detectPackageManager: typeof detectPackageManager;
  runPackageManagerInstall: typeof runPackageManagerInstall;
  detectDeployment: typeof detectDeployment;
}

export interface DeployProjectOptions {
  /** Deploy progress and command output stream through this log (rail styling preserved). */
  prompter: { log: ChannelSetupLog };
  /** Skip the post-channel Vercel deployment entirely (`--no-deploy`). */
  skip?: boolean;
  /**
   * Run even without a planned or detected project, linking interactively from
   * inside `perform` (the `eve channels add` composition; onboarding always has
   * a plan or skips deploy with the channels).
   */
  ensureLinkedProject?: "interactive-vercel-link";
  /**
   * Headless mode: gates interactive `vercel` commands inside `perform`. The box
   * asks no questions, so the dispatch decision the gather faces used to encode
   * comes from the composition site (the same place that picks the asker base),
   * not from a prompt.
   */
  headless?: boolean;
  deps?: DeployProjectDeps;
}

/**
 * What `perform` consumes. The headless flag gates interactive `vercel`
 * commands inside `perform`; it is fixed at composition time (the box prompts
 * for nothing) and passed straight through {@link DeployProjectOptions.headless}.
 */
export interface DeployProjectInput {
  headless: boolean;
}

/** The deploy facts `apply` records: the (re)deployed project and the cleared flags. */
export interface DeployProjectPayload {
  project: ProjectResolution;
  deploymentPending: boolean;
  deploymentDependenciesInstalled: boolean;
}

/**
 * THE DEPLOY BOX. Owns the post-channel `vercel deploy --prod` once channel
 * setup has marked deployment work pending: dependency install (once per
 * state), the production deploy, the env pull, and the deployment probe.
 *
 * The project was linked up front by the link box, so `perform` reuses
 * `state.project` and never triggers a second interactive `vercel link` (the
 * #1020 deadlock). When no resolution exists (no link box ran, e.g. the
 * `eve channels add` composition), it falls back to the interactive bare
 * `vercel link`, or throws {@link HumanActionRequiredError} headlessly.
 */
export function deployProject(
  options: DeployProjectOptions,
): SetupBox<SetupState, DeployProjectInput, DeployProjectPayload> {
  const deps = options.deps ?? {
    runVercel,
    detectPackageManager,
    runPackageManagerInstall,
    detectDeployment,
  };

  return {
    id: "deploy-project",

    shouldRun(state) {
      if (options.skip || !state.deploymentPending) return false;
      return hasVercelProject(state) || options.ensureLinkedProject === "interactive-vercel-link";
    },

    async gather(): Promise<DeployProjectInput> {
      // No questions: the deploy decision is the shouldRun gate, and the headless
      // dispatch is a composition-time fact, so one gather serves every mode.
      return { headless: options.headless ?? false };
    },

    async perform({ state, input, signal }): Promise<DeployProjectPayload> {
      const projectPath = requireProjectPath(state);
      const { log } = options.prompter;
      const onOutput = createPromptCommandOutput(log);

      let project = state.project;
      if (!isProjectResolved(project)) {
        if (input.headless) {
          throw new HumanActionRequiredError({
            kind: "vercel-link",
            command: "vercel link",
            reason: "Deployment needs this directory linked to a Vercel project.",
          });
        }
        // No onOutput: `vercel link` (without --project) is interactive, so it must
        // own the terminal. Piping its prompt through the rail renderer line-buffers
        // the unterminated question and deadlocks the CLI waiting on hidden input.
        log.message("Linking this directory to a Vercel project before deployment...");
        if (!(await deps.runVercel(["link"], { cwd: projectPath, signal }))) {
          signal?.throwIfAborted();
          throw new Error("Vercel project linking failed. Deployment did not start.");
        }
        project = mergeProjectResolution(
          project,
          projectResolutionFromDeployment(await deps.detectDeployment(projectPath, { signal })),
        );
        if (!isProjectResolved(project)) {
          throw new Error("Vercel project linking failed. Deployment did not start.");
        }
      }

      if (!state.deploymentDependenciesInstalled) {
        const packageManager = await deps.detectPackageManager(projectPath);
        const installed = await withPhase(
          log,
          `Installing project dependencies before deployment (${packageManager.kind} install)...`,
          () =>
            deps.runPackageManagerInstall(packageManager.kind, projectPath, { onOutput, signal }),
        );
        if (!installed) {
          signal?.throwIfAborted();
          throw new Error("Dependency installation failed. Deployment did not start.");
        }
      }

      // `--yes` in both modes: it makes the CLI send skipAutoDetectionConfirmation,
      // which the deployments API requires for a project that has never been
      // configured (eve creates projects via the bare projects API, so the record
      // has no framework settings, and the CLI has no interactive recovery for the
      // resulting missing_project_settings error). The deploy decision itself was
      // already made by the shouldRun gate, so there is nothing left to confirm.
      const deployArgs = input.headless
        ? ["deploy", "--prod", "--yes", "--non-interactive"]
        : ["deploy", "--prod", "--yes"];
      const success = await withPhase(log, "Deploying the agent to Vercel production...", () =>
        deps.runVercel(deployArgs, {
          cwd: projectPath,
          extraEnv: VERCEL_DEPLOY_ENV,
          nonInteractive: input.headless,
          onOutput,
          signal,
        }),
      );
      signal?.throwIfAborted();
      if (!success) {
        // Commit the captured `vercel deploy --prod` transcript (the rail keeps it
        // transient until a warning/error settles it) so the build failure is
        // visible instead of just the exit code.
        log.error(
          "`vercel deploy --prod` failed. The deploy output above shows the cause; fix it, then run `vercel deploy --prod` to retry.",
        );
        throw new Error("Deployment failed after channel setup.");
      }

      const pulledEnvironment = await withPhase(
        log,
        "Pulling Vercel environment variables into .env.local...",
        () =>
          deps.runVercel(["env", "pull", "--yes"], {
            cwd: projectPath,
            nonInteractive: input.headless,
            onOutput,
            signal,
          }),
      );
      signal?.throwIfAborted();
      if (!pulledEnvironment) {
        log.warning(
          "Deployment succeeded, but pulling Vercel environment variables did not complete.",
        );
      }
      const info = await deps.detectDeployment(projectPath, { signal });
      const productionUrl = info.state === "deployed" ? info.productionUrl : undefined;
      if (productionUrl !== undefined) {
        log.info(`Production URL: ${productionUrl}`);
      } else {
        log.warning("Deployment succeeded, but eve could not verify its production URL.");
      }
      const deployedProject = projectResolutionFromDeployResult(project, {
        deployed: true,
        productionUrl,
      });
      return {
        project: deployedProject,
        deploymentPending: false,
        deploymentDependenciesInstalled: true,
      };
    },

    apply(state, payload) {
      return {
        ...state,
        project: payload.project,
        deploymentPending: payload.deploymentPending,
        deploymentDependenciesInstalled: payload.deploymentDependenciesInstalled,
      };
    },
  };
}
