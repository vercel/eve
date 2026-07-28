import { createPromptCommandOutput } from "#setup/cli/index.js";

import { isProjectResolved } from "../project-resolution.js";
import type { Prompter } from "../prompter.js";
import { requireProjectPath, type SetupState } from "../state.js";
import type { SetupBox } from "../step.js";
import { syncHostFrameworkPreset } from "../vercel-project-framework.js";

/** Injected for tests; defaults to the real framework-preset reconciliation. */
export interface ReconcileHostFrameworkPresetDeps {
  syncHostFrameworkPreset: typeof syncHostFrameworkPreset;
}

export interface ReconcileHostFrameworkPresetOptions {
  /** Streams reconciliation progress and the applied-change note. */
  prompter: Prompter;
  deps?: ReconcileHostFrameworkPresetDeps;
}

/**
 * Aligns an already-linked Vercel project's Framework Preset with a newly-added
 * web (Next.js) channel before the deploy box runs. A project created as a
 * standalone agent keeps the `eve` preset, which would build the agent instead
 * of the host app; the command already deploys on the user's behalf, so this
 * corrects the preset directly (no confirmation) and notes the change.
 *
 * Runs only for an already-linked project — an unlinked directory links later
 * inside the deploy box, where a fresh `vercel link` detects the framework. All
 * effects live in {@link syncHostFrameworkPreset}, a no-op when the preset
 * already matches.
 */
export function reconcileHostFrameworkPreset(
  options: ReconcileHostFrameworkPresetOptions,
): SetupBox<SetupState, null, null> {
  const deps = options.deps ?? { syncHostFrameworkPreset };

  return {
    id: "reconcile-host-framework-preset",

    shouldRun(state) {
      // Only reconcile ahead of a deploy this run: a stale preset only bites the
      // deployment, and the deploy box gates on `deploymentPending` too, so a
      // no-op channel add must not touch the Vercel setting.
      return (
        state.deploymentPending &&
        state.channelSelection.includes("web") &&
        isProjectResolved(state.project)
      );
    },

    async gather(): Promise<null> {
      return null;
    },

    async perform({ state, signal }): Promise<null> {
      const projectRoot = requireProjectPath(state);
      const onOutput = createPromptCommandOutput(options.prompter.log);
      await deps.syncHostFrameworkPreset(options.prompter, projectRoot, onOutput, { signal });
      return null;
    },

    apply(state): SetupState {
      return state;
    },
  };
}
