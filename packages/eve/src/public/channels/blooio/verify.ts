/**
 * Blooio inbound-webhook verification.
 *
 * Blooio signs webhook requests with `X-Blooio-Signature` using the
 * Stripe-style scheme:
 *
 *   X-Blooio-Signature: t=<unix_seconds>,v1=<hmac_sha256_hex>
 *
 * The signed payload is `<t>.<rawBody>`, keyed with the webhook's
 * signing secret (`whsec_...`). Verification compares in constant time
 * and rejects stale timestamps.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { createLogger } from "#internal/logging.js";
import type { BlooioWebhookSecret } from "#public/channels/blooio/api.js";

const log = createLogger("blooio.verify");

/** Parsed and verified Blooio webhook body. */
export interface BlooioVerifiedRequest {
  readonly body: string;
}

/** Options for {@link verifyBlooioRequest}. */
export interface BlooioVerifyOptions {
  /** Signing secret used to verify the signature. Falls back to `BLOOIO_WEBHOOK_SECRET`. */
  readonly webhookSecret?: BlooioWebhookSecret;
  /** Maximum allowed age of the signature timestamp, in seconds. Defaults to 300 (5 minutes). */
  readonly timestampToleranceSec?: number;
}

const DEFAULT_TOLERANCE_SEC = 300;

/** Resolves the webhook signing secret, falling back to `BLOOIO_WEBHOOK_SECRET`. */
export async function resolveBlooioWebhookSecret(secret?: BlooioWebhookSecret): Promise<string> {
  const source = secret ?? process.env.BLOOIO_WEBHOOK_SECRET;
  if (!source) throw new Error("blooioChannel: BLOOIO_WEBHOOK_SECRET is required.");
  return typeof source === "function" ? await source() : source;
}

/** Parses a `t=...,v1=...` signature header into its components. */
export function parseBlooioSignatureHeader(
  header: string | null,
): { timestamp: number; signature: string } | null {
  if (!header) return null;
  let timestamp: number | undefined;
  let signature: string | undefined;
  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === "t") timestamp = Number(value);
    else if (key === "v1") signature = value;
  }
  if (timestamp === undefined || !Number.isFinite(timestamp) || !signature) return null;
  return { signature, timestamp };
}

/** Computes Blooio's HMAC-SHA256 signature over `<timestamp>.<body>`. */
export function signBlooioPayload(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Verifies an inbound Blooio webhook and returns the raw body.
 *
 * Consumes the request body, so the passed `Request` cannot be re-read
 * afterward. Throws when the signing secret is missing, the
 * `X-Blooio-Signature` header is absent or malformed, the timestamp is
 * outside the tolerance window, or the computed signature does not match.
 */
export async function verifyBlooioRequest(
  request: Request,
  options: BlooioVerifyOptions,
): Promise<BlooioVerifiedRequest> {
  const body = await request.text();
  const secret = await resolveBlooioWebhookSecret(options.webhookSecret);
  const parsed = parseBlooioSignatureHeader(request.headers.get("x-blooio-signature"));
  if (!parsed) {
    throw new Error("blooioChannel: inbound request missing or malformed X-Blooio-Signature.");
  }

  const tolerance = options.timestampToleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parsed.timestamp) > tolerance) {
    throw new Error("blooioChannel: inbound request timestamp outside tolerance.");
  }

  const expected = signBlooioPayload(secret, parsed.timestamp, body);
  if (!constantTimeCompare(expected, parsed.signature)) {
    throw new Error("blooioChannel: inbound request signature mismatch.");
  }

  return { body };
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (error) {
    log.debug("timingSafeEqual threw", { error });
    return false;
  }
}
