import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { resumeRoutedHook } from "#execution/hook-routes.js";

/** Resumes a hook wherever it's held, as a step on Workflow, so the runtime API stays out of the owner. */
export async function resumeHookStep(
  token: string,
  payload: unknown,
  options?: { readonly ifPresent?: boolean },
): Promise<void> {
  "use step";

  try {
    await resumeRoutedHook(token, payload);
  } catch (error) {
    if (options?.ifPresent === true && isTaskWorkflowTargetGone(error)) return;
    throw error;
  }
}
