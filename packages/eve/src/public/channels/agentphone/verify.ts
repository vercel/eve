/**
 * AgentPhone inbound-webhook verification.
 *
 * AgentPhone signs webhook requests with HMAC-SHA256. The signed payload
 * is `{timestamp}.{raw_body}` and the signature is delivered in
 * `X-Webhook-Signature` as `sha256=<hex_digest>`. Requests older than 5
 * minutes are rejected to prevent replay attacks.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { createLogger } from "#internal/logging.js";

const log = createLogger("agentphone.verify");

const REPLAY_WINDOW_SECONDS = 300;

/** Webhook secret, materialized directly or from an async secret provider. */
export type AgentPhoneWebhookSecret = string | (() => string | Promise<string>);

/** Parsed and verified AgentPhone webhook body. */
export interface AgentPhoneVerifiedRequest {
  readonly body: string;
  readonly payload: unknown;
}

/** Options for {@link verifyAgentPhoneRequest}. */
export interface AgentPhoneVerifyOptions {
  readonly webhookSecret: AgentPhoneWebhookSecret | undefined;
}

/** Resolves the webhook secret, falling back to `AGENTPHONE_WEBHOOK_SECRET`. */
export async function resolveAgentPhoneWebhookSecret(
  webhookSecret?: AgentPhoneWebhookSecret,
): Promise<string> {
  const source = webhookSecret ?? process.env.AGENTPHONE_WEBHOOK_SECRET;
  if (!source) throw new Error("AGENTPHONE_WEBHOOK_SECRET is required.");
  return typeof source === "function" ? await source() : source;
}

/**
 * Verifies an inbound AgentPhone webhook and returns the raw body plus parsed JSON.
 *
 * Consumes the request body. Throws when the webhook secret is missing,
 * required headers are absent, the signature does not match, or the
 * timestamp is outside the replay window.
 */
export async function verifyAgentPhoneRequest(
  request: Request,
  options: AgentPhoneVerifyOptions,
): Promise<AgentPhoneVerifiedRequest> {
  const body = await request.text();
  const secret = await resolveAgentPhoneWebhookSecret(options.webhookSecret);

  const signature = request.headers.get("x-webhook-signature") ?? "";
  if (!signature) {
    throw new Error("agentphoneChannel: inbound request missing X-Webhook-Signature.");
  }

  const timestamp = request.headers.get("x-webhook-timestamp") ?? "";
  if (!timestamp) {
    throw new Error("agentphoneChannel: inbound request missing X-Webhook-Timestamp.");
  }

  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > REPLAY_WINDOW_SECONDS) {
    throw new Error("agentphoneChannel: inbound request outside replay window.");
  }

  const expected = signAgentPhoneRequest({ body, secret, timestamp });
  if (!constantTimeCompare(expected, signature)) {
    throw new Error("agentphoneChannel: inbound request signature mismatch.");
  }

  return { body, payload: JSON.parse(body) };
}

/** Computes AgentPhone's HMAC-SHA256 request signature. */
export function signAgentPhoneRequest(input: {
  readonly secret: string;
  readonly timestamp: string;
  readonly body: string;
}): string {
  const signedString = `${input.timestamp}.${input.body}`;
  const digest = createHmac("sha256", input.secret).update(signedString).digest("hex");
  return `sha256=${digest}`;
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
