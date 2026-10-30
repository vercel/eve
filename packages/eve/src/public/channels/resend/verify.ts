import { createHmac, timingSafeEqual } from "node:crypto";

import { sameEnvironmentVercelOidc } from "#public/channels/same-environment-oidc.js";
import type { ResendCredentialValue } from "#public/channels/resend/api.js";

/** Largest webhook body the channel reads. `email.received` carries metadata only. */
const MAX_WEBHOOK_BYTES = 256 * 1024;
/** Svix rejects signatures older or newer than five minutes. */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/**
 * Verifies a webhook forwarded by a trusted provider such as Vercel Connect, given the request
 * and its raw body. Return a falsy value or throw to reject the request.
 */
export type ResendWebhookVerifier = (request: Request, rawBody: Uint8Array) => unknown;

/** Credentials for outbound Resend API calls and inbound webhook verification. */
export interface ResendChannelCredentials {
  /** API key for outbound Resend calls. Defaults to `RESEND_API_KEY`. */
  readonly apiKey?: ResendCredentialValue;
  /** Signing secret (`whsec_…`) for webhooks Resend delivers directly. */
  readonly webhookSecret?: ResendCredentialValue;
  /** Trusted verifier for webhooks forwarded by a provider such as Vercel Connect. */
  readonly webhookVerifier?: ResendWebhookVerifier;
}

/**
 * Reads and verifies an inbound webhook. Returns its body, or `null` to reject it.
 *
 * A `webhookVerifier` wins, then a `webhookSecret`. With neither, the channel accepts only
 * Vercel OIDC from the same project and environment, which is how Vercel Connect forwards events.
 */
export async function verifyResendInbound(
  request: Request,
  credentials: ResendChannelCredentials | undefined,
): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) return null;
  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_WEBHOOK_BYTES) return null;
  const body = new TextDecoder().decode(rawBody);

  const { webhookSecret, webhookVerifier } = credentials ?? {};
  if (webhookVerifier === undefined && webhookSecret !== undefined) {
    const secret = typeof webhookSecret === "function" ? await webhookSecret() : webhookSecret;
    return verifyResendSignature({ body, headers: request.headers, secret }) ? body : null;
  }
  const verifier = webhookVerifier ?? sameEnvironmentVercelOidc();
  try {
    return (await verifier(request, rawBody)) ? body : null;
  } catch {
    return null;
  }
}

/** Verifies Resend's Svix signature headers against a `whsec_…` signing secret. */
export function verifyResendSignature(input: {
  readonly body: string;
  readonly headers: Headers;
  readonly secret: string;
  readonly nowSeconds?: number;
}): boolean {
  const id = input.headers.get("svix-id");
  const timestamp = input.headers.get("svix-timestamp");
  const signatures = input.headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return false;

  const sentAt = Number(timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(sentAt) || Math.abs(now - sentAt) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const expected = Buffer.from(
    signResendPayload({ body: input.body, id, secret: input.secret, timestamp }),
    "base64",
  );
  return signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",", 2);
    if (version !== "v1" || signature === undefined) return false;
    const actual = Buffer.from(signature, "base64");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

/** Computes the base64 Svix `v1` signature Resend sends for a webhook. */
export function signResendPayload(input: {
  readonly body: string;
  readonly id: string;
  readonly secret: string;
  readonly timestamp: string;
}): string {
  const key = Buffer.from(input.secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", key)
    .update(`${input.id}.${input.timestamp}.${input.body}`)
    .digest("base64");
}
