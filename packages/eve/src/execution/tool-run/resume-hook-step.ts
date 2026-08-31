import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/**
 * `resumeHook` as a step, for eve's own bodies: the Workflow runtime API
 * imports Node.js internals that must not enter the workflow driver, so the
 * driver sees the stub the transform leaves behind and the registered step
 * body calls the real runtime in the app process. With `ifPresent`, a hook
 * that no longer exists is not an error.
 */
export async function resumeHookStep(
  token: string,
  payload: unknown,
  options?: { readonly ifPresent?: boolean },
): Promise<void> {
  "use step";

  try {
    await resumeHook(token, payload);
  } catch (error) {
    if (options?.ifPresent === true && isTaskWorkflowTargetGone(error)) return;
    throw error;
  }
}
