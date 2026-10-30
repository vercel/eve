/** A request body read as JSON under a byte cap. */
export type JsonBodyRead =
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "empty" }
  | { readonly kind: "too-large" }
  | { readonly kind: "invalid-json" };

/**
 * Reads `request`'s body as JSON, counting bytes as they stream: a declared `Content-Length` is
 * trusted only to refuse early, so a body that lies about its length still stops at `maxBytes`.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBodyRead> {
  const body = request.body;
  if (body === null) return { kind: "empty" };

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await body.cancel().catch(() => {});
    return { kind: "too-large" };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { kind: "too-large" };
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: "json", value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { kind: "invalid-json" };
  }
}
