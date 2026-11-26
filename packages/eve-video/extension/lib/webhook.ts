import { createHmac, timingSafeEqual } from "node:crypto";

import type { WorkflowWebhookRequest } from "eve/workflow";

import { StreamLimitExceededError, readBoundedStream } from "./media.ts";
import type { VerifyGatewayWebhookInput } from "./types.ts";

const DEFAULT_MAX_AGE_SECONDS = 300;
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const HEX_PATTERN = /^[0-9a-fA-F]+$/;
const DIGITS_PATTERN = /^\d+$/;

/**
 * Verifies a Vercel AI Gateway `x-ai-gateway-signature` webhook header
 * (`t=<unix seconds>,v1=<hex digest>`) against the exact raw request body
 * using HMAC-SHA256, constant-time comparison, and a replay window check.
 */
export function verifyGatewayWebhookSignature(input: VerifyGatewayWebhookInput): boolean {
  if (
    typeof input.header !== "string" ||
    typeof input.secret !== "string" ||
    input.secret.length === 0
  ) {
    return false;
  }
  if (typeof input.rawBody !== "string" && !(input.rawBody instanceof Uint8Array)) {
    return false;
  }
  const parsed = parseSignatureHeader(input.header);
  if (parsed === undefined) {
    return false;
  }
  const timestamp = Number(parsed.timestampText);
  if (!Number.isSafeInteger(timestamp)) {
    return false;
  }
  const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) {
    return false;
  }
  const nowSeconds = input.nowSeconds ?? Date.now() / 1000;
  if (!Number.isFinite(nowSeconds)) {
    return false;
  }
  if (Math.abs(nowSeconds - timestamp) > maxAgeSeconds) {
    return false;
  }
  const hmac = createHmac("sha256", input.secret);
  hmac.update(`${parsed.timestampText}.`, "utf8");
  if (typeof input.rawBody === "string") {
    hmac.update(input.rawBody, "utf8");
  } else {
    hmac.update(input.rawBody);
  }
  const expected = hmac.digest();
  const expectedHexLength = expected.byteLength * 2;
  let matched = false;
  for (const candidateHex of parsed.signatures) {
    if (candidateHex.length !== expectedHexLength || !HEX_PATTERN.test(candidateHex)) {
      continue;
    }
    const received = Buffer.from(candidateHex, "hex");
    if (received.byteLength === expected.byteLength && timingSafeEqual(received, expected)) {
      matched = true;
    }
  }
  return matched;
}

function parseSignatureHeader(
  header: string,
): { readonly timestampText: string; readonly signatures: readonly string[] } | undefined {
  const trimmed = header.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let timestampText: string | undefined;
  const signatures: string[] = [];
  for (const part of trimmed.split(",")) {
    const entry = part.trim();
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex <= 0) {
      return undefined;
    }
    const key = entry.slice(0, equalsIndex).trim();
    const value = entry.slice(equalsIndex + 1).trim();
    if (value.length === 0) {
      return undefined;
    }
    if (key === "t") {
      if (timestampText !== undefined || !DIGITS_PATTERN.test(value)) {
        return undefined;
      }
      timestampText = value;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  if (timestampText === undefined || signatures.length === 0) {
    return undefined;
  }
  return { timestampText, signatures };
}

export async function verifyAndRespondWebhook(
  request: WorkflowWebhookRequest,
  secret: string,
): Promise<boolean> {
  const signatureHeader = request.headers.get("x-ai-gateway-signature");
  if (signatureHeader === null || signatureHeader.trim().length === 0) {
    await request.body?.cancel().catch(() => undefined);
    await respondBestEffort(request, 401);
    return false;
  }

  const declared = request.headers.get("content-length")?.trim();
  const parsedLength = declared ? Number(declared) : Number.NaN;
  if (Number.isFinite(parsedLength) && parsedLength > MAX_WEBHOOK_BODY_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    await respondBestEffort(request, 413);
    return false;
  }

  let rawBody: Uint8Array;
  try {
    if (request.body !== null) {
      rawBody = await readBoundedStream(request.body, MAX_WEBHOOK_BODY_BYTES);
    } else {
      rawBody = new TextEncoder().encode(await request.text());
      if (rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) {
        throw new StreamLimitExceededError(MAX_WEBHOOK_BODY_BYTES);
      }
    }
  } catch (error) {
    if (error instanceof StreamLimitExceededError) {
      await respondBestEffort(request, 413);
      return false;
    }
    throw error;
  }

  const valid = verifyGatewayWebhookSignature({
    header: signatureHeader,
    rawBody,
    secret,
  });
  await respondBestEffort(request, valid ? 204 : 401);
  return valid;
}

async function respondBestEffort(request: WorkflowWebhookRequest, status: number): Promise<void> {
  try {
    await request.respondWith(new Response(null, { status }));
  } catch {}
}
