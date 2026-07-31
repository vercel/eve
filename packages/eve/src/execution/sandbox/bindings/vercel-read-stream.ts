import { Readable } from "node:stream";

import { nodeReadableToWebStream } from "#execution/sandbox/stream-utils.js";

export function normalizeVercelReadStream(
  stream: object | null,
): ReadableStream<Uint8Array> | null {
  if (stream === null || isWebReadableStream(stream)) {
    return stream;
  }
  if (stream instanceof Readable) {
    return nodeReadableToWebStream(stream);
  }
  throw new TypeError("Vercel Sandbox returned an unsupported file stream.");
}

function isWebReadableStream(value: object): value is ReadableStream<Uint8Array> {
  return "getReader" in value && typeof value.getReader === "function";
}
