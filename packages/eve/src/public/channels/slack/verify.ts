/**
 * Slack inbound-webhook verification.
 *
 * The native channel replaces `createSlackAdapter`'s built-in HMAC
 * check with a self-contained verifier:
 *
 * 1. If the caller supplied a {@link SlackWebhookVerifier} (e.g.
 *    Connect's OIDC-based forwarder), delegate to it.
 * 2. Otherwise, recompute the Slack v0 HMAC and compare with
 *    `X-Slack-Signature`. Rejects requests older than five minutes to
 *    foil replay attacks.
 *
 * Returns the verified raw body string on success so the caller can
 * parse it without re-reading the request stream.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { createLogger } from "#internal/logging.js";

const log = createLogger("slack.verify");

/**
 * Caller-supplied inbound webhook verifier. Used as an alternative to
 * HMAC verification — e.g. Connect supplies a verifier that
 * authenticates Connect-forwarded webhooks with Vercel OIDC instead
 * of Slack's signing secret.
 *
 * Contract (matches the chat SDK's `SlackAdapterConfig.webhookVerifier`):
 *
 * - **Throw / reject** → the channel responds 401 to Slack.
 * - **Return a falsy value** (`null` / `undefined` / `false` / `""` /
 *   `0`) → the channel responds 401 to Slack. This lets verifiers
 *   signal rejection without throwing — e.g. Connect's `vercelOidc()`
 *   returns `null` on a failed OIDC check.
 * - **Return a truthy non-string value** → verification accepted.
 * - **Return a string** → verification accepted, and the string
 *   replaces the raw body for downstream parsing. Useful when the
 *   verifier canonicalizes or substitutes the verified payload.
 */
export type SlackWebhookVerifier = (request: Request, body: string) => unknown | Promise<unknown>;

export interface SlackVerifyOptions {
  readonly signingSecret: string | undefined;
  readonly webhookVerifier: SlackWebhookVerifier | undefined;
  /** Max allowed clock skew, in seconds. Defaults to 5 minutes. */
  readonly maxSkewSeconds?: number;
}

/**
 * Verifies an inbound Slack webhook and returns its raw body.
 *
 * Throws when neither a signing secret nor a custom verifier is
 * available, when signature/timestamp checks fail, or when the
 * caller-supplied verifier rejects.
 */
export async function verifySlackRequest(
  request: Request,
  options: SlackVerifyOptions,
): Promise<string> {
  const body = await request.text();

  if (options.webhookVerifier !== undefined) {
    const result = await options.webhookVerifier(request, body);
    if (!result) {
      throw new Error("slackChannel: inbound webhook verifier rejected the request.");
    }
    return typeof result === "string" ? result : body;
  }

  if (!options.signingSecret) {
    throw new Error(
      "slackChannel: missing signing secret. Pass credentials.signingSecret, " +
        "set SLACK_SIGNING_SECRET, or supply credentials.webhookVerifier.",
    );
  }

  const timestampHeader = request.headers.get("x-slack-request-timestamp") ?? "";
  const signatureHeader = request.headers.get("x-slack-signature") ?? "";
  if (!timestampHeader || !signatureHeader) {
    throw new Error("slackChannel: inbound request missing Slack signature headers.");
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    throw new Error("slackChannel: inbound request has malformed timestamp.");
  }

  const maxSkew = options.maxSkewSeconds ?? 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > maxSkew) {
    throw new Error("slackChannel: inbound request timestamp outside allowed skew.");
  }

  const base = `v0:${timestampHeader}:${body}`;
  const expected = `v0=${createHmac("sha256", options.signingSecret).update(base).digest("hex")}`;
  if (!constantTimeCompare(expected, signatureHeader)) {
    throw new Error("slackChannel: inbound request signature mismatch.");
  }

  return body;
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
