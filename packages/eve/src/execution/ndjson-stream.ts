/**
 * Transforms a byte stream of newline-delimited JSON (NDJSON) into a
 * stream of parsed values.
 *
 * The source is read on demand: each pull reads only until it can enqueue
 * at least one value, so a slow consumer applies backpressure to the source
 * instead of this stream buffering everything the source can deliver.
 *
 * Cancellation is forwarded to the source. When the returned stream is
 * cancelled — e.g. an SSE client disconnects and the server cancels the
 * response body — the underlying reader is cancelled too. This matters for
 * runs that never reach EOF: a parked durable run keeps
 * its event stream open indefinitely, and the world-local streamer runs a
 * filesystem poll until its reader is cancelled. Without forwarding the
 * cancel, a pending `reader.read()` would block forever and that poll would
 * leak for the life of the process, degrading streaming throughput for every
 * other session.
 */
export function parseNdjsonStream<T>(
  createByteStream: () => ReadableStream<Uint8Array>,
  parse: (value: unknown) => T = (value) => value as T,
): ReadableStream<T> {
  const decoder = new TextDecoder();
  let buffer = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;

  return new ReadableStream<T>({
    start() {
      reader = createByteStream().getReader();
    },
    async pull(controller) {
      try {
        // A chunk may hold no complete line, and the stream does not pull
        // again until this pull enqueues, so keep reading until it does.
        while (true) {
          const { value, done } = await reader!.read();

          // A cancel resolves the pending read with `done`; bail before
          // touching the controller, which the cancel has already closed.
          if (cancelled) return;

          if (done) {
            buffer += decoder.decode();
            const trailing = buffer.trim();
            if (trailing.length > 0) {
              controller.enqueue(parse(JSON.parse(trailing)));
            }
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });

          let enqueued = false;
          for (
            let newlineIndex = buffer.indexOf("\n");
            newlineIndex !== -1;
            newlineIndex = buffer.indexOf("\n")
          ) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (line.length > 0) {
              controller.enqueue(parse(JSON.parse(line)));
              enqueued = true;
            }
          }
          if (enqueued) return;
        }
      } catch (error) {
        if (cancelled) return;
        controller.error(error);
        // An errored stream never forwards a later cancel, so release the source now.
        await reader!.cancel(error).catch(() => {});
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader?.cancel(reason);
    },
  });
}
