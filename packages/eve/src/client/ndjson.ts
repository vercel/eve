import { throwIfAborted } from "#client/abort-signal.js";
import { classifyRecord, type ReadRecord } from "#protocol/session-events/envelope.js";

export function isStreamDisconnectError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const errorCode = "code" in error && typeof error.code === "string" ? error.code : undefined;

  return (
    error.name === "AbortError" ||
    error.message === "terminated" ||
    errorCode === "UND_ERR_SOCKET" ||
    (error instanceof TypeError &&
      /^(?:failed to fetch|fetch failed|load failed|networkerror when attempting to fetch resource\.)$/i.test(
        error.message,
      )) ||
    /abort|cancel|disconnect|premature close|socket|terminated/i.test(error.message)
  );
}

export async function* readNdjsonStream(
  body: ReadableStream<Uint8Array>,
  options: {
    readonly idleTimeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): AsyncGenerator<ReadRecord> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reachedEof = false;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    while (true) {
      throwIfAborted(options.signal);
      const result = await readWithIdleTimeout(reader, options.idleTimeoutMs);
      throwIfAborted(options.signal);

      if (result.done) {
        reachedEof = true;
        buffer += decoder.decode();
        break;
      }

      if (result.value) {
        buffer += decoder.decode(result.value, { stream: true });
      }

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) yield parseRecord(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }

    const trailing = buffer.trim();
    if (trailing.length > 0) yield parseRecord(trailing);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (!reachedEof) {
      void reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

function parseRecord(line: string): ReadRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "invalid", value: line };
  }
  return classifyRecord(value);
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number | undefined,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (idleTimeoutMs === undefined) return await reader.read();
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new DOMException("Session stream was idle.", "AbortError")),
          idleTimeoutMs,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Session stream disconnected.", { cause: error });
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
