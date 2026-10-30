import { randomUUID } from "node:crypto";
import { SharedHistory } from "#compiled/@workflow/core/index.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/** `resumeHook` as a step, so the runtime API stays out of the owner. */
export async function resumeHookStep(
  token: string,
  payload: unknown,
  options?: { readonly ifPresent?: boolean },
): Promise<void> {
  "use step";

  if (SharedHistory.enabled() && payload !== null && typeof payload === "object") {
    SharedHistory.source(payload, `hook:${randomUUID()}`);
  }
  try {
    await resumeHook(token, payload);
  } catch (error) {
    if (options?.ifPresent === true && isTaskWorkflowTargetGone(error)) return;
    throw error;
  }
}
