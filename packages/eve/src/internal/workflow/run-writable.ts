import { forgetStreamRun, getStreamRun } from "#internal/workflow/stream-run.js";

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
  const run: Awaited<ReturnType<typeof getStreamRun>> & Partial<WritableRun> =
    await getStreamRun(runId);
  if (typeof run.getWritable !== "function") {
    throw new Error("Session storage requires a Workflow SDK with Run#getWritable().");
  }
  try {
    return await run.getWritable<T>(options);
  } catch (error) {
    await forgetStreamRun(runId);
    throw error;
  }
}
