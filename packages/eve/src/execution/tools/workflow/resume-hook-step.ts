import { isWorkflowTargetGone } from "#execution/tools/workflow/target-gone.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/** `resumeHook` as a step, so the runtime API stays out of the owner. */
export async function resumeHookStep(
  token: string,
  payload: unknown,
  options?: { readonly ifPresent?: boolean },
): Promise<void> {
  "use step";

  try {
    await resumeHook(token, payload);
  } catch (error) {
    if (options?.ifPresent === true && isWorkflowTargetGone(error)) return;
    throw error;
  }
}
