import { getRun } from "#internal/workflow/runtime.js";

const OUTCOME_TIMEOUT_MS = 90_000;

export type FirstPublished<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "ended" }
  | { readonly kind: "abandoned" };

/**
 * Reads the first value a workflow run published to `namespace`. Reports `ended` when the run
 * finished without publishing one, and `abandoned` when none arrives in time or `signal` aborts.
 */
export async function readFirstPublished<T>(
  runId: string,
  namespace: string,
  signal?: AbortSignal,
): Promise<FirstPublished<T>> {
  const reader = getRun(runId).getReadable<T>({ namespace }).getReader();
  const deadline = AbortSignal.any([
    AbortSignal.timeout(OUTCOME_TIMEOUT_MS),
    ...(signal === undefined ? [] : [signal]),
  ]);
  const abandoned = new Promise<{ abandoned: true }>((resolve) => {
    const abort = () => resolve({ abandoned: true });
    if (deadline.aborted) abort();
    else deadline.addEventListener("abort", abort, { once: true });
  });
  try {
    const read = await Promise.race([reader.read(), abandoned]);
    if ("abandoned" in read) return { kind: "abandoned" };
    return read.value === undefined ? { kind: "ended" } : { kind: "value", value: read.value };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Reads the first value a workflow run published to `namespace`, or undefined if none arrives in time. */
export async function readPublishedOutcome<T>(
  runId: string,
  namespace: string,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const first = await readFirstPublished<T>(runId, namespace, signal);
  if (first.kind === "ended") throw new Error("Event handler ended before subscribing.");
  return first.kind === "value" ? first.value : undefined;
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
