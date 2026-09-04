import { getRun } from "#internal/workflow/runtime.js";

/** Successful executors persist their outcome in the inbox before completing. */
export async function awaitExecutorStep(runId: string): Promise<void> {
  "use step";
  await getRun(runId).returnValue;
}
