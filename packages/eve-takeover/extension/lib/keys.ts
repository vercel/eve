import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

/**
 * Keys derived from the takeover secret.
 *
 * - The Ed25519 private key signs short-lived stream tokens. Only the agent's
 *   server holds it; the sandbox proxy gets the public key, so code running in
 *   the sandbox, including the model's own shell, cannot mint a token.
 * - The AES key seals the grant carried in the takeover link, so the link
 *   reveals neither the stream URL nor who may open it.
 */

const SALT = "eve-takeover";
const STREAM_TOKEN_AUDIENCE = "eve-takeover";
const GRANT_AAD = Buffer.from("eve-takeover-grant:v1");
/** DER prefix that wraps a raw 32-byte Ed25519 seed as a PKCS#8 private key. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Longest a stream token may live; the proxy refuses tokens that claim more. */
export const STREAM_TOKEN_MAX_TTL_MS = 2 * 60 * 1000;

/** Shortest secret `defineTakeover` accepts. */
export const MIN_SECRET_LENGTH = 32;

export interface TakeoverKeys {
  readonly privateKey: KeyObject;
  /** SPKI DER, base64: what the sandbox proxy verifies stream tokens with. */
  readonly publicKeySpki: string;
  readonly grantKey: Buffer;
}

export function deriveTakeoverKeys(secret: string): TakeoverKeys {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new TypeError(`The takeover secret must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  const seed = Buffer.from(hkdfSync("sha256", secret, SALT, "ed25519-signing-seed", 32));
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeySpki = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const grantKey = Buffer.from(hkdfSync("sha256", secret, SALT, "grant-aes-256-gcm", 32));
  return { privateKey, publicKeySpki, grantKey };
}

// Stream tokens: agent server -> person's browser -> sandbox proxy.

export interface StreamTokenClaims {
  readonly aud: typeof STREAM_TOKEN_AUDIENCE;
  /** eve session id. */
  readonly sid: string;
  /** Tool call id of the takeover. */
  readonly cid: string;
  /** Expiry, epoch milliseconds. */
  readonly exp: number;
  /** One-use id: the proxy refuses a token it already accepted. */
  readonly jti: string;
}

export function mintStreamToken(
  keys: Pick<TakeoverKeys, "privateKey">,
  input: { sessionId: string; callId: string; ttlMs?: number; now?: number },
): { token: string; expiresAt: number } {
  const now = input.now ?? Date.now();
  const ttl = Math.min(input.ttlMs ?? 60_000, STREAM_TOKEN_MAX_TTL_MS);
  const claims: StreamTokenClaims = {
    aud: STREAM_TOKEN_AUDIENCE,
    sid: input.sessionId,
    cid: input.callId,
    exp: now + ttl,
    jti: randomBytes(16).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(claims));
  const signature = sign(null, payload, keys.privateKey);
  return {
    token: `${payload.toString("base64url")}.${signature.toString("base64url")}`,
    expiresAt: claims.exp,
  };
}

/** The checks the sandbox proxy runs, except one-use tracking. Returns the claims or null. */
export function verifyStreamToken(
  publicKeySpki: string,
  token: string,
  expected: { sessionId: string; callId: string; now?: number },
): StreamTokenClaims | null {
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) return null;
  const payload = Buffer.from(encodedPayload, "base64url");
  const publicKey = createPublicKey({
    key: Buffer.from(publicKeySpki, "base64"),
    format: "der",
    type: "spki",
  });
  if (!verify(null, payload, publicKey, Buffer.from(encodedSignature, "base64url"))) return null;
  let claims: Partial<StreamTokenClaims>;
  try {
    claims = JSON.parse(payload.toString("utf8")) as Partial<StreamTokenClaims>;
  } catch {
    return null;
  }
  const now = expected.now ?? Date.now();
  if (
    claims.aud !== STREAM_TOKEN_AUDIENCE ||
    claims.sid !== expected.sessionId ||
    claims.cid !== expected.callId ||
    typeof claims.exp !== "number" ||
    claims.exp <= now ||
    claims.exp > now + STREAM_TOKEN_MAX_TTL_MS ||
    typeof claims.jti !== "string" ||
    claims.jti.length === 0
  ) {
    return null;
  }
  return claims as StreamTokenClaims;
}

// The grant: sealed into the link the person opens.

/** Who asked for the takeover, as their turn's auth recorded it. */
export interface TakeoverRequester {
  readonly authenticator: string;
  readonly principalType: string;
  readonly principalId: string;
  readonly issuer?: string;
  readonly subject?: string;
  readonly attributes: Readonly<Record<string, string | readonly string[]>>;
}

export type TakeoverProtocol = "screencast" | "rfb";

export interface TakeoverGrant {
  readonly v: 1;
  /** eve session id. */
  readonly sid: string;
  /** Tool call id of the takeover. */
  readonly cid: string;
  readonly requester: TakeoverRequester;
  /** `wss://…/stream` on the exposed sandbox port. */
  readonly stream: string;
  /** What the stream speaks, so the viewer picks its renderer. */
  readonly protocol: TakeoverProtocol;
  /** What the person is taking over, such as "browser" or "desktop". */
  readonly label: string;
  /** What the agent asked the person to do. */
  readonly task: string;
  /** eve's sign-in callback for this takeover: opening it hands control back. Revealed only to the requester. */
  readonly callback: string;
  /** Expiry, epoch milliseconds. */
  readonly exp: number;
}

export function sealTakeoverGrant(keys: Pick<TakeoverKeys, "grantKey">, grant: TakeoverGrant) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.grantKey, iv);
  cipher.setAAD(GRANT_AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(grant), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export type OpenedGrant =
  | { readonly status: "ok"; readonly grant: TakeoverGrant }
  | { readonly status: "invalid" | "expired" };

export function openTakeoverGrant(
  keys: Pick<TakeoverKeys, "grantKey">,
  sealed: string,
  now: number = Date.now(),
): OpenedGrant {
  try {
    const bytes = Buffer.from(sealed, "base64url");
    if (bytes.length < 12 + 16 + 2) return { status: "invalid" };
    const decipher = createDecipheriv("aes-256-gcm", keys.grantKey, bytes.subarray(0, 12));
    decipher.setAAD(GRANT_AAD);
    decipher.setAuthTag(bytes.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    const grant = JSON.parse(plaintext.toString("utf8")) as Partial<TakeoverGrant>;
    if (
      grant.v !== 1 ||
      typeof grant.sid !== "string" ||
      typeof grant.cid !== "string" ||
      typeof grant.requester !== "object" ||
      grant.requester === null ||
      typeof grant.stream !== "string" ||
      !grant.stream.startsWith("wss://") ||
      (grant.protocol !== "screencast" && grant.protocol !== "rfb") ||
      typeof grant.label !== "string" ||
      typeof grant.task !== "string" ||
      typeof grant.callback !== "string" ||
      typeof grant.exp !== "number"
    ) {
      return { status: "invalid" };
    }
    if (grant.exp <= now) return { status: "expired" };
    return { status: "ok", grant: grant as TakeoverGrant };
  } catch {
    return { status: "invalid" };
  }
}
