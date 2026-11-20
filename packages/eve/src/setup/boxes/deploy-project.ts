import { createPromptCommandOutput, withPhase, type ChannelSetupLog } from "#setup/cli/index.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import { detectPackageManager } from "#setup/package-manager.js";
import {
  packageManagerInstallSucceeded,
  runPackageManagerInstall,
} from "#setup/primitives/pm/run.js";
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
import { syncHostFrameworkPreset } from "../vercel-project-framework.js";

const VERCEL_DEPLOY_ENV: Readonly<Record<string, string>> = {
  VERCEL_USE_EXPERIMENTAL_FRAMEWORKS: "1",
};

export interface DeployProjectDeps {
  runVercel: typeof runVercel;
  detectPackageManager: typeof detectPackageManager;
  runPackageManagerInstall: typeof runPackageManagerInstall;
  detectDeployment: typeof detectDeployment;
  syncHostFrameworkPreset: typeof syncHostFrameworkPreset;
}

interface DeployProjectOptions {
  prompter: { log: ChannelSetupLog };
  skip?: boolean;
  ensureLinkedProject?: "interactive-vercel-link";
  headless?: boolean;
  deps?: DeployProjectDeps;
}

interface DeployProjectInput {
  headless: boolean;
}

interface DeployProjectPayload {
  project: ProjectResolution;
  deploymentPending: boolean;
  deploymentDependenciesInstalled: boolean;
}

export function deployProject(
  options: DeployProjectOptions,
): SetupBox<SetupState, DeployProjectInput, DeployProjectPayload> {
  const deps = options.deps ?? {
    runVercel,
    detectPackageManager,
    runPackageManagerInstall,
    detectDeployment,
    syncHostFrameworkPreset,
  };

  return {
    id: "deploy-project",

    shouldRun(state) {
      if (options.skip || !state.deploymentPending) return false;
      return hasVercelProject(state) || options.ensureLinkedProject === "interactive-vercel-link";
    },

    async gather(): Promise<DeployProjectInput> {
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

      await deps.syncHostFrameworkPreset(
        options.prompter,
        projectPath,
        onOutput,
        signal ? { signal } : {},
      );

      if (!state.deploymentDependenciesInstalled) {
        const packageManager = await deps.detectPackageManager(projectPath);
        const installResult = await withPhase(
          log,
          `Installing project dependencies before deployment (${packageManager.kind} install)...`,
          () =>
            deps.runPackageManagerInstall(packageManager.kind, projectPath, { onOutput, signal }),
        );
        if (!packageManagerInstallSucceeded(installResult)) {
          signal?.throwIfAborted();
          throw new Error("Dependency installation failed. Deployment did not start.");
        }
      }

      const deployArgs = [
        "deploy",
        "--prod",
        "--yes",
        "--logs",
        ...(input.headless ? ["--non-interactive"] : []),
      ];
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
        log.error(
          "`vercel deploy --prod` failed. Check the build logs above for the first error, then retry. To retrieve the logs again, run `vercel inspect <deployment-url> --logs` from this project.",
        );
        throw new Error(
          "Deployment failed. Check the build logs above, or run `vercel inspect <deployment-url> --logs` from this project.",
        );
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
