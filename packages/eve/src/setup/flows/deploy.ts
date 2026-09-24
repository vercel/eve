import { inspectApplication } from "#services/inspect-application.js";
import { isChatGptModelRouting } from "#shared/chatgpt-model.js";

import { interactiveAsker, withAnswers } from "../ask.js";
import { deployProject, type DeployProjectDeps } from "../boxes/deploy-project.js";
import { linkVercelProject, type LinkProjectDeps } from "../boxes/link-project.js";
import {
  resolveProvisioning,
  type ResolveProvisioningDeps,
} from "../boxes/resolve-provisioning.js";
import {
  detectDeployment,
  isProjectResolved,
  projectResolutionFromDeployment,
  type ProjectResolution,
} from "../project-resolution.js";
import type { Prompter } from "../prompter.js";
import { runHeadless, runInteractive, type AnySetupBox } from "../runner.js";
import { snapshotSetupState, type SetupState } from "../state.js";
import { offerTraceSampling } from "../vercel-trace-sampling.js";
import { withSpinner } from "../with-spinner.js";

import { inProjectSetupState, prompterSink } from "./in-project.js";
import { runInstallVercelCliFlow } from "./install-vercel-cli.js";
import { runLoginFlow } from "./login.js";

/** Injected for tests; defaults to the real detection and box effects. */
export interface DeployFlowDeps {
  detectDeployment: typeof detectDeployment;
  inspectApplication: typeof inspectApplication;
  runLoginFlow: typeof runLoginFlow;
  runInstallVercelCliFlow: typeof runInstallVercelCliFlow;
  resolveProvisioning?: ResolveProvisioningDeps;
  linkProject?: LinkProjectDeps;
  deployProject?: DeployProjectDeps;
  offerTraceSampling: typeof offerTraceSampling;
}

export type DeployFlowResult =
  | { kind: "deployed"; productionUrl?: string }
  | { kind: "cancelled" }
  | { kind: "local-model" }
  /** Unlinked directory in a non-interactive run: refused before any effect. */
  | { kind: "needs-link" };

function productionUrlOf(project: ProjectResolution): string | undefined {
  return project.kind === "deployed" ? project.productionUrl : undefined;
}

/**
 * Interactive deployment prepares CLI access before linking or deploying.
 * Noninteractive deployment never installs tools or starts browser login.
 */
export async function runDeployFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  traceSampling?: boolean;
  /** False when no TTY: an unlinked directory refuses instead of prompting. */
  interactive: boolean;
  deps?: Partial<DeployFlowDeps>;
}): Promise<DeployFlowResult> {
  const { appRoot, prompter, interactive, signal } = input;
  const deps: DeployFlowDeps = {
    detectDeployment,
    inspectApplication,
    runLoginFlow,
    runInstallVercelCliFlow,
    offerTraceSampling,
    ...input.deps,
  };

  try {
    const application = await deps.inspectApplication(appRoot);
    const routing = application.compiledState?.manifest.config.model?.routing;
    if (isChatGptModelRouting(routing)) {
      return { kind: "local-model" };
    }
  } catch {
    // Existing deploy behavior remains authoritative when the app has not compiled yet.
  }

  const deployment = await withSpinner(
    prompter,
    "Checking the current Vercel link...",
    async () => {
      const deployment = await deps.detectDeployment(appRoot, { signal });
      signal?.throwIfAborted();
      return deployment;
    },
  );
  const project = projectResolutionFromDeployment(deployment);

  const linked = isProjectResolved(project);
  if (!linked && !interactive) {
    return { kind: "needs-link" };
  }
  if (interactive) {
    let login = await deps.runLoginFlow({ appRoot, prompter, signal });
    if (login.kind === "cli-missing") {
      const install = await deps.runInstallVercelCliFlow({ appRoot, prompter, signal });
      if (install.kind === "cancelled") return { kind: "cancelled" };
      if (install.kind === "failed")
        throw new Error(
          "Could not install the Vercel CLI. Install it with `npm i -g vercel@latest`, then retry deployment.",
        );
      login = await deps.runLoginFlow({ appRoot, prompter, signal });
    }
    if (login.kind === "cancelled") return { kind: "cancelled" };
    if (login.kind !== "already" && login.kind !== "logged-in")
      throw new Error(
        login.kind === "unavailable"
          ? "Could not reach Vercel. Check your connection and retry deployment."
          : "Vercel login did not complete. Retry deployment to sign in.",
      );
  }

  const state = inProjectSetupState(appRoot, project, { deploymentPending: true });
  const boxes: AnySetupBox<SetupState>[] = linked
    ? [deployProject({ prompter, headless: !interactive, deps: deps.deployProject })]
    : [
        resolveProvisioning({
          asker: withAnswers({ deploy: "vercel" })(interactiveAsker(prompter)),
          prompter,
          targetDirectory: appRoot,
          mode: { headless: false },
          deps: deps.resolveProvisioning,
        }),
        linkVercelProject({
          prompter,
          traceSampling: input.traceSampling,
          deps: deps.linkProject,
        }),
        deployProject({ prompter, headless: !interactive, deps: deps.deployProject }),
      ];

  const sink = prompterSink(prompter);
  if (!interactive) {
    const finalState = await runHeadless(boxes, state, sink, {
      snapshot: snapshotSetupState,
      signal,
    });
    return { kind: "deployed", productionUrl: productionUrlOf(finalState.project) };
  }
  const result = await runInteractive(boxes, state, sink, {
    snapshot: snapshotSetupState,
    signal,
  });
  if (result.kind === "cancelled") {
    return { kind: "cancelled" };
  }
  const deployedProject = result.state.project;
  if (
    input.traceSampling !== false &&
    (linked || result.state.vercelProject.kind === "existing") &&
    deployedProject.kind !== "unresolved"
  ) {
    try {
      await deps.offerTraceSampling(appRoot, deployedProject.projectId, prompter, signal);
    } catch {
      prompter.log.warning(
        "Deployment succeeded, but eve could not check trace sampling. Check the Vercel project's Tracing settings if you need Agent Runs.",
      );
    }
  }
  return { kind: "deployed", productionUrl: productionUrlOf(deployedProject) };
}
