import type { SessionAuthContext } from "#channel/types.js";

/**
 * Stateless, HMAC-signed control token for the Gateway-owned realtime voice
 * control socket.
 *
 * Eve mints this at `/setup` (carrying the authenticated principal and the
 * `voiceSessionId`) and hands it to AI Gateway as the realtime `control.token`.
 * Gateway later dials Eve's `WS()` control route and presents it as
 * `Authorization: Bearer <token>`. Because the mint and the WS upgrade are
 * different (serverless) invocations with no shared per-session store, the token
 * is self-verifying: the upgrade recomputes the HMAC and checks expiry/audience
 * rather than looking the secret up. The signature is the unforgeable capability
 * that authorizes Gateway to drive durable turns as the bound principal.
 */

const TOKEN_PREFIX = "evc1";
const AUDIENCE = "eve-voice-control";

interface ControlTokenPayload {
  readonly aud: typeof AUDIENCE;
  /** Expiry, epoch seconds. */
  readonly exp: number;
  /** Issued-at, epoch seconds. */
  readonly iat: number;
  /** Authenticated principal the durable turns run as. */
  readonly auth: SessionAuthContext;
  /** Client-visible voice session correlation id. */
  readonly vsid: string;
}

export interface CreateControlTokenInput {
  readonly auth: SessionAuthContext;
  readonly voiceSessionId: string;
  readonly ttlSeconds: number;
  readonly secret: string;
  readonly now?: number;
}

export interface ResolveControlSecretOptions {
  /**
   * Allows preview/local setups to derive the signing secret from
   * `AI_GATEWAY_API_KEY`. Disabled by default so the Gateway credential is not
   * also the Eve control-plane signing root in production.
   */
  readonly allowGatewayKeyFallback?: boolean;
}

export type VerifyControlTokenResult =
  | { readonly ok: true; readonly auth: SessionAuthContext; readonly voiceSessionId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolves the HMAC signing secret. Prefers an explicit value, then
 * `EVE_REALTIME_CONTROL_SECRET`. Preview/dev can opt into a domain-separated
 * derivation from `AI_GATEWAY_API_KEY`, but production should use a dedicated
 * control-plane secret.
 */
export function resolveControlSecret(
  explicit?: string,
  options: ResolveControlSecretOptions = {},
): string {
  const allowGatewayKeyFallback =
    options.allowGatewayKeyFallback === true ||
    process.env.EVE_REALTIME_CONTROL_ALLOW_GATEWAY_KEY_FALLBACK === "1";
  const candidate =
    readNonEmpty(explicit) ??
    readNonEmpty(process.env.EVE_REALTIME_CONTROL_SECRET) ??
    (allowGatewayKeyFallback
      ? deriveFallbackSecret(readNonEmpty(process.env.AI_GATEWAY_API_KEY))
      : undefined);
  if (candidate === undefined) {
    throw new Error(
      "Eve realtime voice control requires a signing secret. Set EVE_REALTIME_CONTROL_SECRET.",
    );
  }
  return candidate;
}

/** Signs a control token binding the principal + voice session id, with expiry. */
export async function createControlToken(input: CreateControlTokenInput): Promise<string> {
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const payload: ControlTokenPayload = {
    aud: AUDIENCE,
    exp: iat + Math.max(1, Math.floor(input.ttlSeconds)),
    iat,
    auth: input.auth,
    vsid: input.voiceSessionId,
  };
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await sign(`${TOKEN_PREFIX}.${body}`, input.secret);
  return `${TOKEN_PREFIX}.${body}.${signature}`;
}

/** Verifies signature, audience, and expiry; returns the bound principal. */
export async function verifyControlToken(
  token: string | undefined | null,
  input: { readonly secret: string; readonly now?: number },
): Promise<VerifyControlTokenResult> {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "missing_token" };
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    return { ok: false, reason: "malformed_token" };
  }
  const [, body, signature] = parts;
  const expected = await sign(`${TOKEN_PREFIX}.${body}`, input.secret);
  if (!timingSafeEqual(signature ?? "", expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: ControlTokenPayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(body ?? "")),
    ) as ControlTokenPayload;
  } catch {
    return { ok: false, reason: "malformed_payload" };
  }
  if (payload.aud !== AUDIENCE) return { ok: false, reason: "bad_audience" };

  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) {
    return { ok: false, reason: "expired" };
  }
  if (!isSessionAuthContext(payload.auth) || typeof payload.vsid !== "string") {
    return { ok: false, reason: "malformed_payload" };
  }

  return { ok: true, auth: payload.auth, voiceSessionId: payload.vsid };
}

async function sign(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(digest));
}

function deriveFallbackSecret(apiKey: string | undefined): string | undefined {
  if (apiKey === undefined) return undefined;
  // Domain-separate so the control-token secret is never byte-identical to the
  // Gateway credential, even though it is derived from it.
  return `eve-realtime-control:${apiKey}`;
}

function isSessionAuthContext(value: unknown): value is SessionAuthContext {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as SessionAuthContext).principalId === "string" &&
    typeof (value as SessionAuthContext).principalType === "string" &&
    typeof (value as SessionAuthContext).authenticator === "string"
  );
}

function readNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
