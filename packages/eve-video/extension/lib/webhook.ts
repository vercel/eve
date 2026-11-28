import { createHmac, timingSafeEqual } from "node:crypto";

import type { WorkflowWebhookRequest } from "eve/workflow";

import { StreamLimitExceededError, readBoundedStream } from "./media.ts";

const MAX_BODY = 64 * 1024;

export function verifyGatewayWebhookSignature(
  header: string,
  rawBody: string | Uint8Array,
  secret: string,
  options?: { readonly maxAgeSeconds?: number; readonly nowSeconds?: number },
): boolean {
  if (typeof header !== "string" || typeof secret !== "string" || !secret) return false;
  if (typeof rawBody !== "string" && !(rawBody instanceof Uint8Array)) return false;

  let tsText: string | undefined;
  const sigs: string[] = [];
  for (const part of header.trim().split(",")) {
    const entry = part.trim();
    const eq = entry.indexOf("=");
    if (eq <= 0) return false;
    const [key, val] = [entry.slice(0, eq).trim(), entry.slice(eq + 1).trim()];
    if (!val) return false;
    if (key === "t") {
      if (tsText !== undefined || !/^\d+$/.test(val)) return false;
      tsText = val;
    } else if (key === "v1") sigs.push(val);
  }
  const ts = Number(tsText);
  const maxAge = options?.maxAgeSeconds ?? 300;
  const now = options?.nowSeconds ?? Date.now() / 1000;
  if (
    !tsText ||
    !sigs.length ||
    !Number.isSafeInteger(ts) ||
    !Number.isFinite(maxAge) ||
    maxAge < 0 ||
    !Number.isFinite(now) ||
    Math.abs(now - ts) > maxAge
  )
    return false;

  const hmac = createHmac("sha256", secret).update(`${tsText}.`, "utf8");
  const expected = (
    typeof rawBody === "string" ? hmac.update(rawBody, "utf8") : hmac.update(rawBody)
  ).digest();
  let matched = false;
  for (const hex of sigs) {
    if (hex.length !== expected.byteLength * 2 || !/^[0-9a-fA-F]+$/.test(hex)) continue;
    const received = Buffer.from(hex, "hex");
    if (received.byteLength === expected.byteLength && timingSafeEqual(received, expected))
      matched = true;
  }
  return matched;
}

export async function verifyAndRespondWebhook(
  request: WorkflowWebhookRequest,
  secret: string,
): Promise<boolean> {
  const reply = (status: number) =>
    request.respondWith(new Response(null, { status })).catch(() => undefined);
  const sig = request.headers.get("x-ai-gateway-signature")?.trim();
  if (!sig) {
    await request.body?.cancel().catch(() => undefined);
    await reply(401);
    return false;
  }
  const declared = Number(request.headers.get("content-length")?.trim() || Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    await request.body?.cancel().catch(() => undefined);
    await reply(413);
    return false;
  }
  let rawBody: Uint8Array;
  try {
    rawBody = request.body
      ? await readBoundedStream(request.body, MAX_BODY)
      : new TextEncoder().encode(await request.text());
    if (rawBody.byteLength > MAX_BODY) throw new StreamLimitExceededError(MAX_BODY);
  } catch (error) {
    if (error instanceof StreamLimitExceededError) {
      await reply(413);
      return false;
    }
    throw error;
  }
  const valid = verifyGatewayWebhookSignature(sig, rawBody, secret);
  await reply(valid ? 204 : 401);
  return valid;
}
