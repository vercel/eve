import { createHmac, timingSafeEqual } from "node:crypto";

import { createLogger } from "#internal/logging.js";
import {
  resolveLinearWebhookSecret,
  type LinearWebhookSecret,
} from "#public/channels/linear/auth.js";
import { isObject } from "#shared/guards.js";

const log = createLogger("linear.verify");

/**
 * Caller-supplied inbound webhook verifier. Use it as an alternative to
 * Linear's HMAC secret, for example when a trusted proxy authenticates the
 * request before it reaches eve.
 *
 * - Throw / reject / return falsy: request rejected.
 * - Return a string: request accepted and that string replaces the raw body.
 * - Return any other truthy value: request accepted and the original body is
 *   used.
 */
export type LinearWebhookVerifier = (request: Request, body: string) => unknown | Promise<unknown>;

export interface LinearVerifyOptions {
  /** Max allowed webhook timestamp skew in milliseconds. Defaults to 60s. */
  readonly maxSkewMs?: number;
  readonly webhookSecret?: LinearWebhookSecret;
  readonly webhookVerifier?: LinearWebhookVerifier;
}

/** Verifies a Linear webhook request and returns its raw body. */
export async function verifyLinearRequest(
  request: Request,
  options: LinearVerifyOptions,
): Promise<string> {
  const body = await request.text();

  if (options.webhookVerifier !== undefined) {
    const result = await options.webhookVerifier(request, body);
    if (!result) {
      throw new Error("linearChannel: inbound webhook verifier rejected the request.");
    }
    return typeof result === "string" ? result : body;
  }

  const secret = await resolveLinearWebhookSecret(options.webhookSecret);
  const signatureHeader = request.headers.get("linear-signature") ?? "";
  if (!signatureHeader) {
    throw new Error("linearChannel: inbound request missing Linear-Signature.");
  }

  const expected = signLinearWebhookBody(body, secret);
  if (!constantTimeCompare(expected, signatureHeader)) {
    throw new Error("linearChannel: inbound request signature mismatch.");
  }

  verifyWebhookTimestamp(body, options.maxSkewMs ?? 60_000);
  return body;
}

/** Signs a raw Linear webhook body for tests and local fixtures. */
export function signLinearWebhookBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function verifyWebhookTimestamp(body: string, maxSkewMs: number): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error("linearChannel: inbound request body is not valid JSON.");
  }

  const timestamp = isObject(parsed) ? parsed.webhookTimestamp : undefined;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new Error("linearChannel: inbound request missing webhookTimestamp.");
  }

  if (Math.abs(Date.now() - timestamp) > maxSkewMs) {
    throw new Error("linearChannel: inbound request timestamp outside allowed skew.");
  }
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
