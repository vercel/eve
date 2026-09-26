/** A revision request that keeps the plan task working until its work is cancelled. */
export const HOLD_REQUEST = "hold until cancelled";

/**
 * Stands in for revision work that honors cancellation: a hold request works
 * until `signal` aborts and then rejects, as an aborted fetch would.
 */
export async function revise(request: string, signal: AbortSignal): Promise<string> {
  if (request === HOLD_REQUEST) await rejectOnAbort(signal);
  return request;
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new Error("The revision was cancelled."));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
