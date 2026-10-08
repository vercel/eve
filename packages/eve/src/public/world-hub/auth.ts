import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Fixed order and JSON encoding prevent ambiguous boundaries between metadata fields.
const signedHeaders = [
  "x-world-hub-deployment-id",
  "x-world-hub-deployment-url",
  "x-vqs-queue-name",
  "x-vqs-message-id",
  "x-vqs-message-attempt",
] as const;

export function signWorldHubRequest(
  secret: string,
  method: string,
  path: string,
  body: string | Uint8Array = "",
  timestamp = String(Date.now()),
  headers: Headers = new Headers(),
): Record<string, string> {
  const digest = createHash("sha256").update(body).digest("hex");
  const metadata = JSON.stringify(signedHeaders.map((name) => headers.get(name) ?? ""));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${method.toUpperCase()}.${path}.${digest}.${metadata}`)
    .digest("hex");
  return {
    ...Object.fromEntries(headers),
    "x-world-hub-timestamp": timestamp,
    "x-world-hub-signature": `v2=${signature}`,
  };
}

export function verifyWorldHubRequest(
  secret: string,
  method: string,
  path: string,
  body: string | Uint8Array,
  headers: Headers,
  now = Date.now(),
): boolean {
  const timestamp = headers.get("x-world-hub-timestamp");
  const signature = headers.get("x-world-hub-signature");
  if (
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 300_000 ||
    !signature ||
    !/^v2=[a-f0-9]{64}$/.test(signature)
  )
    return false;
  const expected = signWorldHubRequest(secret, method, path, body, timestamp, headers)[
    "x-world-hub-signature"
  ]!;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
