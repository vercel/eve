import { EveAttachmentError } from "#internal/attachments/errors.js";

/**
 * Reads a download's body, failing as soon as it passes `maxBytes`. Checks a
 * declared `content-length` first, then counts what streams in, so a body that
 * misstates or omits its length still stops at the limit.
 */
export async function readLimitedBytes(
  response: Response,
  maxBytes: number,
  adapterKind: string,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw overLimit(maxBytes, adapterKind);
  }
  if (response.body === null) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw overLimit(maxBytes, adapterKind);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Fails a download whose bytes arrived some other way than a `Response`, once they're in hand. */
export function assertWithinLimit(bytes: Uint8Array, maxBytes: number, adapterKind: string): void {
  if (bytes.byteLength > maxBytes) throw overLimit(maxBytes, adapterKind);
}

function overLimit(maxBytes: number, adapterKind: string): EveAttachmentError {
  return new EveAttachmentError({
    adapterKind,
    kind: "resolver-threw",
    message: `it is over the ${formatMegabytes(maxBytes)} upload limit.`,
  });
}

function formatMegabytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}
