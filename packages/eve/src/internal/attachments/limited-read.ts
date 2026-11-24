import { EveAttachmentError } from "#internal/attachments/errors.js";

export async function readLimitedBytes(
  response: Pick<Response, "body" | "headers">,
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

export function assertWithinLimit(bytes: Uint8Array, maxBytes: number, adapterKind: string): void {
  if (bytes.byteLength > maxBytes) throw overLimit(maxBytes, adapterKind);
}

export function overLimit(maxBytes: number, adapterKind: string): EveAttachmentError {
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
