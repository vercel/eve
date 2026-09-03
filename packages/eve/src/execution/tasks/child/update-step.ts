import { resumeHook } from "#internal/workflow/runtime.js";
import type { TaskInboundUpdate } from "#tasks/types.js";

/** Forwards a local task-owned child's progress update to its active parent hook. */
export async function forwardLocalTaskUpdateStep(input: {
  readonly parentContinuationToken: string;
  readonly update: TaskInboundUpdate;
}): Promise<void> {
  "use step";

  await resumeHook(input.parentContinuationToken, input.update);
}
