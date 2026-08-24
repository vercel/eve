/**
 * Driver-side `workflow/api` for authored workflow bodies.
 *
 * The Workflow SDK's runtime API drives runs from outside a body and imports
 * Node.js internals that must not enter the workflow driver bundle. eve
 * exposes it to bodies as `"use step"` wrappers: the driver sees the stubs the
 * transform leaves behind, and the registered step bodies call the real
 * runtime in the app process. The SDK's `Run` object is not serializable
 * across that boundary, so `start` returns the run id — a body collects a
 * child's result on a hook it passed in, and cancels by id.
 */
import {
  cancelRun as runtimeCancelRun,
  resumeHook as runtimeResumeHook,
  start as runtimeStart,
  getWorld,
} from "#internal/workflow/runtime.js";

export async function start(...args: Parameters<typeof runtimeStart>): Promise<string> {
  "use step";

  const run = await runtimeStart(...(args as Parameters<typeof runtimeStart>));
  return run.runId;
}

export async function resumeHook(
  ...args: Parameters<typeof runtimeResumeHook>
): Promise<Awaited<ReturnType<typeof runtimeResumeHook>>> {
  "use step";

  return await runtimeResumeHook(...(args as Parameters<typeof runtimeResumeHook>));
}

export async function cancelRun(runId: string, reason?: string): Promise<void> {
  "use step";

  await runtimeCancelRun(
    await getWorld(),
    runId,
    reason === undefined ? undefined : { cancelReason: reason },
  );
}
