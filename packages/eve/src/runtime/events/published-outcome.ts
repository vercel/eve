import { getRun } from "#internal/workflow/runtime.js";

const OUTCOME_TIMEOUT_MS = 90_000;

/** Reads the first value a workflow run published to `namespace`, or undefined if none arrives in time. */
export async function readPublishedOutcome<T>(
  runId: string,
  namespace: string,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const reader = getRun(runId).getReadable<T>({ namespace }).getReader();
  const deadline = AbortSignal.any([
    AbortSignal.timeout(OUTCOME_TIMEOUT_MS),
    ...(signal === undefined ? [] : [signal]),
  ]);
  const abandoned = new Promise<{ value: undefined; abandoned: true }>((resolve) => {
    const abort = () => resolve({ value: undefined, abandoned: true });
    if (deadline.aborted) abort();
    else deadline.addEventListener("abort", abort, { once: true });
  });
  try {
    const read = await Promise.race([reader.read(), abandoned]);
    if ("abandoned" in read) return undefined;
    if (read.value === undefined) throw new Error("Event handler ended before subscribing.");
    return read.value;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Reads the first published value without waiting for one: undefined when the run has published nothing yet. */
export async function readPublishedOutcomeNow<T>(
  runId: string,
  namespace: string,
): Promise<T | undefined> {
  const readable = getRun(runId).getReadable({ namespace });
  const tail = await readable.getTailIndex();
  await readable.cancel().catch(() => {});
  return tail < 0 ? undefined : readPublishedOutcome<T>(runId, namespace);
}
