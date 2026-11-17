import { createPublicKey, verify } from "node:crypto";

import { createLogger } from "#internal/logging.js";

const log = createLogger("discord.verify");

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Discord application public key, materialized directly or from an async secret provider. */
export type DiscordPublicKey = string | (() => string | Promise<string>);

/**
 * Caller-supplied inbound webhook verifier. Replaces Ed25519 verification
 * when an integration authenticates forwarded webhooks before they reach
 * eve. Receives the request and raw body.
 *
 * Return a falsy value to reject the request. Return a string to accept it
 * and use that string as the (possibly rewritten) body. Return any other
 * truthy value to accept it and keep the original body.
 */
export type DiscordWebhookVerifier = (request: Request, body: string) => unknown | Promise<unknown>;

export interface DiscordVerifyOptions {
  readonly publicKey: DiscordPublicKey | undefined;
  readonly webhookVerifier?: DiscordWebhookVerifier;
  readonly maxSkewSeconds?: number;
}

export async function resolveDiscordPublicKey(publicKey?: DiscordPublicKey): Promise<string> {
  const source = publicKey ?? process.env.DISCORD_PUBLIC_KEY;
  if (!source) throw new Error("DISCORD_PUBLIC_KEY is required.");
  return typeof source === "function" ? await source() : source;
}

export async function verifyDiscordRequest(
  request: Request,
  options: DiscordVerifyOptions,
): Promise<string> {
  const body = await request.text();

  if (options.webhookVerifier !== undefined) {
    const result = await options.webhookVerifier(request, body);
    if (!result) {
      throw new Error("discordChannel: inbound webhook verifier rejected the request.");
    }
    return typeof result === "string" ? result : body;
  }

  const publicKey = await resolveDiscordPublicKey(options.publicKey);
  const signature = request.headers.get("x-signature-ed25519") ?? "";
  const timestamp = request.headers.get("x-signature-timestamp") ?? "";
  if (!signature || !timestamp) {
    throw new Error("discordChannel: inbound request missing Discord signature headers.");
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    throw new Error("discordChannel: inbound request has malformed timestamp.");
  }

  const maxSkew = options.maxSkewSeconds ?? 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampSeconds) > maxSkew) {
    throw new Error("discordChannel: inbound request timestamp outside allowed skew.");
  }

  if (!verifyDiscordSignature({ body, publicKey, signature, timestamp })) {
    throw new Error("discordChannel: inbound request signature mismatch.");
  }

  return body;
}

export function verifyDiscordSignature(input: {
  readonly body: string;
  readonly publicKey: string;
  readonly signature: string;
  readonly timestamp: string;
}): boolean {
  try {
    const publicKeyBytes = Buffer.from(input.publicKey, "hex");
    const signatureBytes = Buffer.from(input.signature, "hex");
    if (publicKeyBytes.length !== 32 || signatureBytes.length !== 64) return false;
    const key = createPublicKey({
      format: "der",
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      type: "spki",
    });
    return verify(null, Buffer.from(`${input.timestamp}${input.body}`), key, signatureBytes);
  } catch (error) {
    log.debug("Discord signature verification threw", { error });
    return false;
  }
}
