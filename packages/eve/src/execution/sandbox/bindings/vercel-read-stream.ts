import { Readable } from "node:stream";

export function normalizeVercelReadStream(
  stream: object | null,
  release: () => void,
): ReadableStream<Uint8Array> | null {
  if (stream === null) {
    release();
    return null;
  }
  const readable = isWebReadableStream(stream)
    ? stream
    : stream instanceof Readable
      ? (Readable.toWeb(stream) as ReadableStream<Uint8Array>)
      : undefined;
  if (readable === undefined) {
    throw new TypeError("Vercel Sandbox returned an unsupported file stream.");
  }
  const reader = readable.getReader();
  const finish = () => {
    release();
    reader.releaseLock();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
}

function isWebReadableStream(value: object): value is ReadableStream<Uint8Array> {
  return "getReader" in value && typeof value.getReader === "function";
}
