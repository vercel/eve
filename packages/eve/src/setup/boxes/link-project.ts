import { createPromptCommandOutput } from "#setup/cli/index.js";

import {
  detectProjectResolution,
  mergeProjectResolution,
  type ProjectResolution,
} from "../project-resolution.js";
import type { Prompter } from "../prompter.js";
import { requireProjectPath, type SetupState } from "../state.js";
import type { SetupBox } from "../step.js";
import { linkProject, resolveProjectByNameOrId, unresolvedProject } from "../vercel-project.js";

/** Injected for tests; defaults to the real Vercel project helpers. */
export interface LinkProjectDeps {
  linkProject: typeof linkProject;
  detectProjectResolution: typeof detectProjectResolution;
  resolveProjectByNameOrId: typeof resolveProjectByNameOrId;
  unresolvedProject: typeof unresolvedProject;
}

export interface LinkProjectOptions {
  /** Streams link progress and command output. The box never prompts through it. */
  prompter: Prompter;
  deps?: LinkProjectDeps;
}

/**
 * THE PROJECT BOX. Executes the resolved Vercel project plan after scaffolding,
 * once the project directory exists (so `vercel link` can write `.vercel/`).
 * The gather prompts for nothing: every decision was made up front by the
 * resolve-provisioning box, so `perform` owns all the work.
 *
 * The plan is authoritative. The box always re-links to the planned project so
 * a stale or mismatched `.vercel` link can never silently win over the choice
 * made up front. `vercel link --project X --yes` is an idempotent rewrite, so
 * re-runs stay safe. The resolution read back from `.vercel/project.json` lands
 * in `state.project`, which every later box reads.
 *
 * Named `linkVercelProject` because the setup island also exports the
 * `linkProject` executor helper this box drives.
 */
export function linkVercelProject(
  options: LinkProjectOptions,
): SetupBox<SetupState, null, ProjectResolution> {
  const deps = options.deps ?? {
    linkProject,
    detectProjectResolution,
    resolveProjectByNameOrId,
    unresolvedProject,
  };

  return {
    id: "link-project",

    shouldRun(state) {
      return state.vercelProject.kind !== "none";
    },

    async gather(): Promise<null> {
      return null;
    },

    async perform({ state, signal }): Promise<ProjectResolution> {
      const plan = state.vercelProject;
      if (plan.kind === "none") {
        return deps.unresolvedProject();
      }
      const projectRoot = requireProjectPath(state);
      const onOutput = createPromptCommandOutput(options.prompter.log);
      const linked = await deps.linkProject(options.prompter, projectRoot, plan, onOutput, {
        signal,
      });
      signal?.throwIfAborted();
      if (!linked) {
        throw new Error(
          "Vercel project provisioning did not complete. Run `vercel link` manually, or re-run and choose not to deploy to Vercel.",
        );
      }
      const resolution = await deps.detectProjectResolution(projectRoot, { signal });
      if (resolution.kind === "unresolved") {
        throw new Error(
          "Linked the directory, but could not resolve the Vercel project from .vercel/project.json.",
        );
      }
      const expectedProject = await deps.resolveProjectByNameOrId(
        projectRoot,
        plan.team,
        plan.project,
        { signal },
      );
      if (expectedProject === null || resolution.projectId !== expectedProject.id) {
        throw new Error(
          `Linked project identity did not match the planned Vercel project "${plan.project}".`,
        );
      }
      return resolution;
    },

    apply(state, project) {
      return { ...state, project: mergeProjectResolution(state.project, project) };
    },
  };
}
