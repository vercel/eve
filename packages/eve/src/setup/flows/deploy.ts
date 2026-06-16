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

import { inProjectSetupState, prompterSink } from "./in-project.js";

/** Injected for tests; defaults to the real detection and box effects. */
export interface DeployFlowDeps {
  detectDeployment: typeof detectDeployment;
  resolveProvisioning?: ResolveProvisioningDeps;
  linkProject?: LinkProjectDeps;
  deployProject?: DeployProjectDeps;
}

export type DeployFlowResult =
  | { kind: "deployed"; productionUrl?: string }
  | { kind: "cancelled" }
  /** Unlinked directory in a non-interactive run: refused before any effect. */
  | { kind: "needs-link" };

function productionUrlOf(project: ProjectResolution): string | undefined {
  return project.kind === "deployed" ? project.productionUrl : undefined;
}

/**
 * THE DEPLOY FLOW, shared by `eve deploy` and the dev TUI's `/deploy`. Link
 * state is the safety-critical input for a deploy, so it is re-detected at
 * decision time, never trusted from an earlier render. An already-linked
 * project goes straight to the deploy box; an unlinked one walks the same
 * team/project pickers as onboarding (resolve-provisioning with the deploy
 * gate pre-answered — invoking deploy IS the deploy decision), then links
 * non-interactively so the deploy box never hits its bare-`vercel link`
 * fallback. A non-interactive run with no link refuses with `needs-link`
 * before any side effect.
 */
export async function runDeployFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  /** False when no TTY: an unlinked directory refuses instead of prompting. */
  interactive: boolean;
  deps?: Partial<DeployFlowDeps>;
}): Promise<DeployFlowResult> {
  const { appRoot, prompter, interactive, signal } = input;
  const deps: DeployFlowDeps = { detectDeployment, ...input.deps };

  const spinner = prompter.log.spinner?.("Checking the current Vercel link...");
  let project: ProjectResolution;
  try {
    const deployment = await deps.detectDeployment(appRoot, { signal });
    signal?.throwIfAborted();
    project = projectResolutionFromDeployment(deployment);
  } finally {
    spinner?.stop();
  }

  const linked = isProjectResolved(project);
  if (!linked && !interactive) {
    return { kind: "needs-link" };
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
        linkVercelProject({ prompter, deps: deps.linkProject }),
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
  return { kind: "deployed", productionUrl: productionUrlOf(result.state.project) };
}
