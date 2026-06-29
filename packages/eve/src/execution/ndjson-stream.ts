/**
 * Transforms a byte stream of newline-delimited JSON (NDJSON) into a
 * stream of parsed values.
 *
 * The byte stream is produced lazily by `createByteStream`, so the
 * underlying source (a world-local run readable) is only opened when the
 * returned stream is consumed.
 *
 * Cancellation is forwarded to the source. When the returned stream is
 * cancelled — e.g. an SSE client disconnects and the server cancels the
 * response body — the underlying reader is cancelled too. This matters for
 * runs that never reach EOF: a parked (`session.waiting`) durable run keeps
 * its event stream open indefinitely, and the world-local streamer runs a
 * filesystem poll until its reader is cancelled. Without forwarding the
 * cancel, the read loop below would block on `reader.read()` forever and
 * that poll would leak for the life of the process, degrading streaming
 * throughput for every other session.
 */
export function parseNdjsonStream<T>(
  createByteStream: () => ReadableStream<Uint8Array>,
): ReadableStream<T> {
  const decoder = new TextDecoder();
  let buffer = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;

  return new ReadableStream<T>({
    async start(controller) {
      reader = createByteStream().getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();

          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          for (
            let newlineIndex = buffer.indexOf("\n");
            newlineIndex !== -1;
            newlineIndex = buffer.indexOf("\n")
          ) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (line.length > 0) {
              controller.enqueue(JSON.parse(line) as T);
            }
          }
        }

        // A cancel resolves the pending read with `done`; bail before
        // touching the controller, which the cancel has already closed.
        if (cancelled) return;

        buffer += decoder.decode();
        const trailing = buffer.trim();
        if (trailing.length > 0) {
          controller.enqueue(JSON.parse(trailing) as T);
        }
        controller.close();
      } catch (error) {
        if (!cancelled) controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader?.cancel(reason);
    },
  });
}
