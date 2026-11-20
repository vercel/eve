import { getRun } from "#internal/workflow/runtime.js";

const OUTCOME_TIMEOUT_MS = 90_000;

export type FirstPublished<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "ended" }
  | { readonly kind: "abandoned" };

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

export async function readPublishedOutcome<T>(
  runId: string,
  namespace: string,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const first = await readFirstPublished<T>(runId, namespace, signal);
  if (first.kind === "ended") throw new Error("Event handler ended before subscribing.");
  return first.kind === "value" ? first.value : undefined;
}

export async function readPublishedOutcomeNow<T>(
  runId: string,
  namespace: string,
): Promise<T | undefined> {
  const readable = getRun(runId).getReadable({ namespace });
  const tail = await readable.getTailIndex();
  await readable.cancel().catch(() => {});
  return tail < 0 ? undefined : readPublishedOutcome<T>(runId, namespace);
}
