import { getRun } from "#internal/workflow/runtime.js";

/** The public SDK contract pending the Workflow upgrade. */
interface RunWritableOptions {
  readonly namespace?: string;
  readonly ops?: Promise<unknown>[];
  readonly global?: Record<string, unknown>;
}

interface WritableRun {
  getWritable<T>(options?: RunWritableOptions): Promise<WritableStream<T>>;
}

/** Remove the declaration shim when the installed SDK exports Run#getWritable. */
export async function getRunWritable<T>(
  runId: string,
  options: RunWritableOptions,
): Promise<WritableStream<T>> {
  const run: ReturnType<typeof getRun> & Partial<WritableRun> = getRun(runId);
  if (typeof run.getWritable !== "function") {
    throw new Error("Session storage requires a Workflow SDK with Run#getWritable().");
  }
  return run.getWritable<T>(options);
}
