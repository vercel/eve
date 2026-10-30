import { constants as zlibConstants, inflateSync } from "node:zlib";

import { readImageDimensions, type MediaMetadata } from "#internal/attachments/media-metadata.js";

// Page dictionaries take about 200 bytes each, so this covers tens of
// thousands of pages while capping what a crafted object stream can inflate.
const MAX_OBJECT_STREAM_BYTES = 16 * 1024 * 1024;
// Writers pack 50 to a few hundred objects per stream, so real files stay far
// below this; the cap bounds per-stream inflate setup on crafted input.
const MAX_OBJECT_STREAMS = 10_000;

/**
 * Reads the dimensions or page count of a whole payload. Counting PDF pages
 * needs `node:zlib`, which the workflow driver bundle rejects, so only step
 * code may import this module.
 */
export function readMediaMetadata(bytes: Uint8Array, mediaType: string): MediaMetadata {
  const metadata = { mediaType, size: bytes.byteLength };
  if (mediaType.startsWith("image/")) {
    const dimensions = readImageDimensions(bytes);
    return dimensions === undefined ? metadata : { ...metadata, ...dimensions };
  }
  if (mediaType === "application/pdf") {
    const pages = countPdfPages(bytes);
    return pages === undefined ? metadata : { ...metadata, pages };
  }
  return metadata;
}

function countPdfPages(bytes: Uint8Array): number | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = buffer.toString("latin1");
  const pages = countPageObjects(text) || countObjectStreamPages(buffer, text);
  return pages > 0 ? pages : undefined;
}

function countPageObjects(text: string): number {
  return text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
}

/**
 * Counts the page objects PDF 1.5+ writers pack into FlateDecode object
 * streams. One stream that fails to inflate within the shared budget makes
 * the whole count unknown, so no file can force more inflation than the budget.
 * The scan resumes after each stream, so every byte is searched and inflated
 * at most once.
 */
function countObjectStreamPages(buffer: Buffer, text: string): number {
  const objectStream = /\/Type\s*\/ObjStm(?![A-Za-z])/g;
  let pages = 0;
  let streams = 0;
  let budget = MAX_OBJECT_STREAM_BYTES;
  for (let match = objectStream.exec(text); match !== null; match = objectStream.exec(text)) {
    if (++streams > MAX_OBJECT_STREAMS) return 0;
    const keyword = text.indexOf("stream", match.index);
    const end = text.indexOf("endstream", keyword);
    if (keyword < 0 || end < 0) return 0;
    objectStream.lastIndex = end;
    const start = keyword + (text.startsWith("stream\r\n", keyword) ? 8 : 7);
    try {
      const objects = inflateSync(buffer.subarray(start, end), {
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
        maxOutputLength: budget,
      });
      budget -= objects.byteLength;
      pages += countPageObjects(objects.toString("latin1"));
    } catch {
      return 0;
    }
  }
  return pages;
}
