import { EveAttachmentError } from "#internal/attachments/errors.js";
import type { UploadPolicy } from "#public/channels/upload-policy.js";

/** The byte cap an upload policy sets; a disabled policy accepts nothing. */
export function maxBytesOf(policy: UploadPolicy): number {
  return policy === "disabled" ? 0 : policy.maxBytes;
}

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

/**
 * Wraps `fetch` so every response body fails once it passes `maxBytes`, for a
 * download that reads the body itself, such as a vendored client's.
 */
export function limitedFetch(
  fetchImpl: typeof globalThis.fetch,
  maxBytes: number,
  adapterKind: string,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      throw overLimit(maxBytes, adapterKind);
    }
    if (response.body === null) return response;
    let received = 0;
    const capped = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > maxBytes) controller.error(overLimit(maxBytes, adapterKind));
          else controller.enqueue(chunk);
        },
      }),
    );
    return new Response(capped, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
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
