import type { HandleMessageStreamEvent } from "#protocol/message.js";

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
    /abort|cancel|disconnect|premature close|socket|terminated/i.test(error.message)
  );
}

/**
 * Reads newline-delimited JSON events from a `ReadableStream<Uint8Array>`.
 *
 * Yields one parsed {@link HandleMessageStreamEvent} per complete NDJSON line.
 * Handles partial lines across chunks via an internal buffer.
 *
 * All read errors — including socket disconnections — propagate to the caller.
 * Use {@link isStreamDisconnectError} to classify them.
 */
export async function* readNdjsonStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<HandleMessageStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) {
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
          yield JSON.parse(line) as HandleMessageStreamEvent;
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }

    // Yield any trailing content without a final newline.
    const trailing = buffer.trim();
    if (trailing.length > 0) {
      yield JSON.parse(trailing) as HandleMessageStreamEvent;
    }
  } finally {
    reader.releaseLock();
  }
}
