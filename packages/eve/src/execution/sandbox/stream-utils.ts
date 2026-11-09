import { concatHostBytes } from "#platform/host-bytes.js";
/** Collects all chunks of a `ReadableStream<Uint8Array>` into one array of the host's bytes. */
export async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return concatHostBytes(chunks);
}

/**
 * Wraps a byte buffer as a single-chunk `ReadableStream<Uint8Array>`.
 */
export function bufferToStream(buf: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buf);
      controller.close();
    },
  });
}
