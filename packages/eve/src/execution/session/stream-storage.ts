import { getRun } from "#internal/workflow/runtime.js";
import { getRunWritable } from "#internal/workflow/run-writable.js";
import { decodeStreamLocation } from "#execution/session/stream-location.js";

const READ_TIMEOUT_MS = 10_000;

export function readStream<T>(id: string, startIndex?: number) {
  const { runId, namespace } = decodeStreamLocation(id);
  return getRun(runId).getReadable<T>({ namespace, startIndex });
}

export async function streamTailIndex(id: string): Promise<number> {
  const readable = readStream(id);
  try {
    return await readable.getTailIndex();
  } finally {
    await readable.cancel();
  }
}

/** Reads one existing record, or waits once for holder initialization. */
export async function readStreamRecord<T>(id: string, startIndex = 0): Promise<T> {
  const reader = readStream<T>(id, startIndex).getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Session storage read timed out.")),
          READ_TIMEOUT_MS,
        );
      }),
    ]);
    if (result.done) throw new Error("Session storage record does not exist.");
    return result.value;
  } finally {
    clearTimeout(timeout);
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Writes stay inside one step; releasing a contributor never closes the session stream. */
export async function withStreamWriter<T, Result>(
  id: string,
  run: (writable: WritableStream<T>) => Promise<Result>,
): Promise<Result> {
  const { runId, namespace } = decodeStreamLocation(id);
  const ops: Promise<unknown>[] = [];
  const writable = await getRunWritable<T>(runId, { namespace, ops });
  let outcome: { kind: "returned"; value: Result } | { kind: "threw"; error: unknown };
  try {
    outcome = { kind: "returned", value: await run(writable) };
  } catch (error) {
    outcome = { kind: "threw", error };
  }
  if (writable.locked) {
    const error = new Error(
      "Session stream writer must be released before completing its operation.",
    );
    if (outcome.kind === "threw")
      throw new AggregateError(
        [outcome.error, error],
        "Session stream operation failed before releasing its writer.",
      );
    throw error;
  }
  const failures = (await Promise.allSettled(ops)).flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (outcome.kind === "threw") {
    if (failures.length > 0)
      throw new AggregateError(
        [outcome.error, ...failures],
        "Session stream operation and durability flush failed.",
      );
    throw outcome.error;
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Session stream durability flush failed.");
  return outcome.value;
}

export async function appendStreamRecords<T>(
  id: string,
  records: readonly T[],
  close = false,
): Promise<void> {
  await withStreamWriter<T, void>(id, async (writable) => {
    const writer = writable.getWriter();
    try {
      for (const record of records) await writer.write(record);
      if (close) await writer.close();
    } finally {
      writer.releaseLock();
    }
  });
}
