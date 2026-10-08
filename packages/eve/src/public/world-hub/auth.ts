import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function signWorldHubRequest(
  secret: string,
  method: string,
  path: string,
  body: string | Uint8Array = "",
  timestamp = String(Date.now()),
): Record<string, string> {
  const digest = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${method.toUpperCase()}.${path}.${digest}`)
    .digest("hex");
  return { "x-world-hub-timestamp": timestamp, "x-world-hub-signature": `v1=${signature}` };
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
    !/^v1=[a-f0-9]{64}$/.test(signature)
  )
    return false;
  const expected = signWorldHubRequest(secret, method, path, body, timestamp)[
    "x-world-hub-signature"
  ]!;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
