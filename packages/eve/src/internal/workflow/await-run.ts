import { getRun } from "#internal/workflow/runtime.js";

/** Awaits native completion; a failed run rejects with its original error. */
export async function awaitRunStep(runId: string): Promise<void> {
  "use step";
  await getRun(runId).returnValue;
}
