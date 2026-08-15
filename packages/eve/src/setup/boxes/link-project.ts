import { createPromptCommandOutput } from "#setup/cli/index.js";

import {
  detectProjectResolution,
  mergeProjectResolution,
  type ProjectResolution,
} from "../project-resolution.js";
import type { Prompter } from "../prompter.js";
import { requireProjectPath, type SetupState } from "../state.js";
import type { SetupBox } from "../step.js";
import { linkProject, unresolvedProject } from "../vercel-project.js";

/** Injected for tests; defaults to the real Vercel project helpers. */
export interface LinkProjectDeps {
  linkProject: typeof linkProject;
  detectProjectResolution: typeof detectProjectResolution;
  unresolvedProject: typeof unresolvedProject;
}

export interface LinkProjectOptions {
  /** Streams link progress and, in interactive runs, may confirm ambiguous framework detection. */
  prompter: Prompter;
  /** Headless runs must not ask follow-up questions after the plan is fixed. */
  headless?: boolean;
  deps?: LinkProjectDeps;
}

/**
 * Executes the resolved Vercel project plan after scaffolding, once the project
 * directory exists. Gather prompts for nothing: the team/project decision was
 * made in the resolve-provisioning box. Interactive runs may still confirm
 * ambiguous host framework detections; headless runs resolve those
 * deterministically inside `linkProject`.
 *
 * The plan is authoritative: the box always re-links to the planned project so
 * a stale or mismatched `.vercel` link can't silently win. Re-linking the same
 * identity is idempotent. The resolution read back from the link metadata lands
 * in `state.project`.
 */
export function linkVercelProject(
  options: LinkProjectOptions,
): SetupBox<SetupState, null, ProjectResolution> {
  const deps = options.deps ?? {
    linkProject,
    detectProjectResolution,
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
      const linked = await deps.linkProject(
        options.prompter,
        projectRoot,
        plan,
        onOutput,
        options.headless ? { signal, headless: true } : { signal },
      );
      signal?.throwIfAborted();
      if (!linked) {
        throw new Error(
          "Vercel project provisioning did not complete. Run `vercel link` manually, or re-run and choose not to deploy to Vercel.",
        );
      }
      const resolution = await deps.detectProjectResolution(projectRoot, { signal });
      if (resolution.kind === "unresolved") {
        throw new Error(
          "Linked the directory, but could not resolve the Vercel project from its link metadata.",
        );
      }
      if (resolution.projectId !== linked.projectId) {
        throw new Error(
          `The linked project does not match the selected project: expected ${linked.projectId}, found ${resolution.projectId}.`,
        );
      }
      return resolution;
    },

    apply(state, project) {
      return { ...state, project: mergeProjectResolution(state.project, project) };
    },
  };
}
