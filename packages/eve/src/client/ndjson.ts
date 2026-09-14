import { type MessageStreamEvent } from "#protocol/message.js";
import {
  normalizeMessageStreamEvent,
  type MessageStreamEventForVersion,
  type MessageStreamVersion,
} from "#protocol/message-version.js";

/**
 * Returns true when an error looks like a stream socket disconnection that
 * can be recovered via reconnection.
 */
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
    (error instanceof TypeError && /^(?:failed to fetch|fetch failed)$/i.test(error.message)) ||
    /abort|cancel|disconnect|premature close|socket|terminated/i.test(error.message)
  );
}

/**
 * Reads newline-delimited JSON events from a `ReadableStream<Uint8Array>`.
 *
 * Yields one parsed {@link MessageStreamEvent} per complete NDJSON line.
 * Handles partial lines across chunks via an internal buffer.
 *
 * All read errors — including socket disconnections — propagate to the caller.
 * Use {@link isStreamDisconnectError} to classify them.
 */
export async function* readNdjsonStream(
  body: ReadableStream<Uint8Array>,
  options: {
    readonly idleTimeoutMs?: number;
    readonly streamVersion: MessageStreamVersion;
  },
): AsyncGenerator<MessageStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reachedEof = false;

  try {
    while (true) {
      const result = await readWithIdleTimeout(reader, options?.idleTimeoutMs);

      if (result.done) {
        reachedEof = true;
        // Flush any remaining bytes in the decoder.
        buffer += decoder.decode();
        break;
      }

      if (result.value) {
        buffer += decoder.decode(result.value, { stream: true });
      }

      // Yield every complete line currently in the buffer.
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line.length > 0) {
          yield parseMessageStreamEvent(line, options.streamVersion);
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }

    // Yield any trailing content without a final newline.
    const trailing = buffer.trim();
    if (trailing.length > 0) {
      yield parseMessageStreamEvent(trailing, options.streamVersion);
    }
  } finally {
    if (!reachedEof) {
      // A cloned response waits for both branches to cancel. Let the caller
      // abort the fetch instead of blocking cleanup on a tracing reader.
      void reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

function parseMessageStreamEvent<Version extends MessageStreamVersion>(
  line: string,
  version: Version,
): MessageStreamEvent {
  const event = JSON.parse(line) as MessageStreamEventForVersion<Version>;
  return normalizeMessageStreamEvent(version, event);
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
    // Browsers use vendor-specific TypeError messages for response-body transport failures.
    if (error instanceof TypeError) {
      throw new Error("Session stream disconnected.", { cause: error });
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
