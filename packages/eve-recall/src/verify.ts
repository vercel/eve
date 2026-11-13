import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/** Resolves the Recall workspace verification secret, falling back to `RECALL_WORKSPACE_VERIFICATION_SECRET`. */
export function resolveRecallVerificationSecret(secret?: string): string {
  const resolved = (secret ?? process.env.RECALL_WORKSPACE_VERIFICATION_SECRET)?.trim();
  if (!resolved) {
    throw new Error(
      "recallChannel: RECALL_WORKSPACE_VERIFICATION_SECRET is required to verify Recall webhooks. Copy it from the Recall dashboard (Developers > Webhooks) or pass credentials.verificationSecret.",
    );
  }
  return resolved;
}

/**
 * Verifies the Svix-style signature Recall puts on real-time and bot status
 * webhooks. Recall signs both with the workspace verification secret.
 */
export function verifyRecallWebhook(input: {
  readonly headers: Headers;
  readonly payload: string;
  readonly secret: string;
  readonly now?: number;
}): boolean {
  const { headers } = input;
  const id = headers.get("webhook-id") ?? headers.get("svix-id");
  const timestamp = headers.get("webhook-timestamp") ?? headers.get("svix-timestamp");
  const signatures = headers.get("webhook-signature") ?? headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return false;

  const seconds = Number(timestamp);
  const now = (input.now ?? Date.now()) / 1000;
  if (!Number.isInteger(seconds) || Math.abs(now - seconds) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const expected = Buffer.from(signRecallWebhook({ ...input, id, timestamp: seconds }), "base64");
  return signatures.split(" ").some((candidate) => {
    const [version, signature] = candidate.split(",", 2);
    if (version !== "v1" || !signature) return false;
    const received = Buffer.from(signature, "base64");
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
}

/** Computes the base64 `v1` signature Recall sends for one webhook delivery. */
export function signRecallWebhook(input: {
  readonly id: string;
  readonly payload: string;
  readonly secret: string;
  readonly timestamp: number;
}): string {
  const key = Buffer.from(input.secret.replace(/^whsec_/u, ""), "base64");
  return createHmac("sha256", key)
    .update(`${input.id}.${input.timestamp}.${input.payload}`)
    .digest("base64");
}
