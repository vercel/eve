import { getRun } from "#internal/workflow/runtime.js";
import {
  normalizePersistedMessageStreamEvent,
  type MessageStreamEventForVersion,
  type MessageStreamVersion,
} from "#protocol/message-version.js";
import type { IndexedRecord } from "#execution/run-observation/state.js";

const MAX_EVENTS = 200;
const MAX_BYTES = 512 * 1024;
const READ_TIMEOUT_MS = 5_000;

type ReadResult = {
  readonly capturedTail: number;
  readonly records: readonly IndexedRecord[];
  readonly nextIndex: number;
  readonly outcome: "caught-up" | "page" | "oversized" | "partial";
};

/** Reads a captured, finite prefix of the local durable stream without following a parked run. */
export async function readLocalObservationPage(input: {
  readonly sessionId: string;
  readonly startIndex: number;
}): Promise<ReadResult> {
  "use step";

  const run = getRun(input.sessionId);
  const probe = run.getReadable();
  let capturedTail: number;
  try {
    capturedTail = await probe.getTailIndex();
  } finally {
    await probe.cancel().catch(() => {});
  }
  if (input.startIndex > capturedTail + 1) {
    throw new Error("Observation source tail is behind its saved cursor.");
  }
  if (input.startIndex > capturedTail) {
    return { capturedTail, records: [], nextIndex: input.startIndex, outcome: "caught-up" };
  }

  const readable = run.getReadable<Uint8Array>({ startIndex: input.startIndex });
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  const records: IndexedRecord[] = [];
  try {
    while (input.startIndex + records.length <= capturedTail && records.length < MAX_EVENTS) {
      const result = await readWithTimeout(reader);
      if (result.done) throw new Error("Observation stream ended before its captured tail.");
      bytes += result.value.byteLength;
      buffer += decoder.decode(result.value, { stream: true });
      for (
        let end = buffer.indexOf("\n");
        end !== -1 &&
        input.startIndex + records.length <= capturedTail &&
        records.length < MAX_EVENTS;
        end = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        if (new TextEncoder().encode(line).byteLength > MAX_BYTES) {
          return {
            capturedTail,
            records,
            nextIndex: input.startIndex + records.length,
            outcome: "oversized",
          };
        }
        const event = normalizePersistedMessageStreamEvent(
          JSON.parse(line) as MessageStreamEventForVersion<MessageStreamVersion>,
        );
        records.push({ index: input.startIndex + records.length, event });
      }
      if (bytes > MAX_BYTES) {
        return {
          capturedTail,
          records,
          nextIndex: input.startIndex + records.length,
          outcome: "oversized",
        };
      }
    }
  } catch (error) {
    if (records.length > 0) {
      return {
        capturedTail,
        records,
        nextIndex: input.startIndex + records.length,
        outcome: "partial",
      };
    }
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return {
    capturedTail,
    records,
    nextIndex: input.startIndex + records.length,
    outcome: "page",
  };
}

async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Observation read timed out.")), READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
