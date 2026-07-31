export async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function bufferToStream(buf: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buf);
      controller.close();
    },
  });
}

export function nodeReadableToWebStream(stream: Readable): ReadableStream<Uint8Array> {
  // Node and DOM declare incompatible stream variance even though both carry bytes here.
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}
import { Readable } from "node:stream";
