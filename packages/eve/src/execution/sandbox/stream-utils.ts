export interface StreamToBufferOptions {
  readonly maxBytes?: number;
  readonly onOverflow?: () => void;
}

export async function streamToBuffer(
  stream: ReadableStream<Uint8Array>,
  options?: StreamToBufferOptions,
): Promise<Buffer> {
  const maxBytes = options?.maxBytes;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (maxBytes !== undefined && total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        options?.onOverflow?.();
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export function bufferToStream(buf: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buf);
      controller.close();
    },
  });
}
