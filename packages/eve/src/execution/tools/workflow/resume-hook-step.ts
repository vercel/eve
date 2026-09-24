import { isWorkflowTargetGone } from "#execution/tools/workflow/target-gone.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/**
 * `resumeHook` as a step, so the runtime API stays out of the owner. Returns
 * whether the hook took the payload: `false` only with `ifPresent`, when the
 * hook's run is gone.
 */
export async function resumeHookStep(
  token: string,
  payload: unknown,
  options?: { readonly ifPresent?: boolean },
): Promise<boolean> {
  "use step";

  try {
    await resumeHook(token, payload);
    return true;
  } catch (error) {
    if (options?.ifPresent === true && isWorkflowTargetGone(error)) return false;
    throw error;
  }
}
