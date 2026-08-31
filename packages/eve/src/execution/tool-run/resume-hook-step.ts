import { resumeHook } from "#internal/workflow/runtime.js";

/**
 * `resumeHook` as a step, for eve's own bodies: the Workflow runtime API
 * imports Node.js internals that must not enter the workflow driver, so the
 * driver sees the stub the transform leaves behind and the registered step
 * body calls the real runtime in the app process.
 */
export async function resumeHookStep(token: string, payload: unknown): Promise<void> {
  "use step";

  await resumeHook(token, payload);
}
