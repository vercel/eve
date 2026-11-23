import { readImageDimensions, type MediaMetadata } from "#internal/attachments/media-metadata.js";
import { inflateBounded } from "#runtime-env/inflate.js";
import { latin1String } from "#shared/bytes.js";

const MAX_OBJECT_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_OBJECT_STREAMS = 10_000;

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
  const text = latin1String(bytes);
  const pages = countPageObjects(text) || countObjectStreamPages(bytes, text);
  return pages > 0 ? pages : undefined;
}

function countPageObjects(text: string): number {
  return text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
}

function countObjectStreamPages(bytes: Uint8Array, text: string): number {
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
    const objects = inflateBounded(bytes.subarray(start, end), budget);
    if (objects === undefined) return 0;
    budget -= objects.byteLength;
    pages += countPageObjects(latin1String(objects));
  }
  return pages;
}
