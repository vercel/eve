import { ConnectionAuthorizationFailedError, type ConnectionPrincipal } from "eve/connections";
import { z } from "zod";

export const scopes = "brokered-credentials:request-access brokered-credentials:read";
export interface Config { origin: string; redirectUri: string; clientId: string; clientSecret: string; databaseUrl: string; encryptionKey: Buffer }
export function failed(reason: string): never {
  throw new ConnectionAuthorizationFailedError("onepassword", { reason, retryable: false, message: `1Password: ${reason}.` });
}
export function personalConnectionsEnabled(): boolean { return process.env.ONEPASSWORD_ENABLED === "true"; }
export function requirePersonalConnections(): void {
  if (!personalConnectionsEnabled()) failed("personal_1password_disabled");
}
export function ownerOf(principal: ConnectionPrincipal): string {
  if (principal.type !== "user" || principal.issuer !== "linq" || !/^linq:.{1,507}$/.test(principal.id)) return failed("authenticated_sender_required");
  return JSON.stringify([principal.issuer, principal.id]);
}
export function configuration(): Config {
  const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) return failed(`configure_${name}`); return value; };
  const origin = required("BELL_PUBLIC_URL");
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:" || parsed.origin !== origin) return failed("invalid_public_origin");
  const redirectUri = `${origin}/api/onepassword/callback`;
  if (required("ONEPASSWORD_REDIRECT_URI") !== redirectUri) return failed("invalid_redirect_uri");
  const encoded = required("ONEPASSWORD_TOKEN_ENCRYPTION_KEY"), encryptionKey = Buffer.from(encoded, "base64");
  if (encryptionKey.length !== 32 || encryptionKey.toString("base64") !== encoded) return failed("invalid_encryption_key");
  return { origin, redirectUri, encryptionKey, databaseUrl: required("DATABASE_URL"), clientId: required("ONEPASSWORD_CLIENT_ID"), clientSecret: required("ONEPASSWORD_CLIENT_SECRET") };
}
const keyEnvelope = z.object({ ver: z.literal(1), typ: z.literal("oauth_integration_key"), key: z.string().regex(/^[a-fA-F0-9]{64}$/), path: z.string() });
export function integrationIdentity(value: string, clientId: string) {
  if (!/^ops_[A-Za-z0-9_-]{1,4096}$/.test(value)) return failed("invalid_integration_key");
  let parsed: z.infer<typeof keyEnvelope>;
  try { parsed = keyEnvelope.parse(JSON.parse(Buffer.from(value.slice(4), "base64url").toString("utf8"))); }
  catch { return failed("invalid_integration_key"); }
  const parts = /^\/\/api\.1password\.com\/oauth-clients\/([A-Za-z0-9_-]+)\/accounts\/([A-Za-z0-9_-]+)\/users\/([A-Za-z0-9_-]+)$/.exec(parsed.path);
  if (!parts || parts[1] !== clientId) return failed("integration_key_connection_mismatch");
  return { path: parsed.path, accountId: parts[2], userId: parts[3] };
}
export function frameworkCallback(value: string, origin: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || !/^\/eve\/v1\/connections\/[^/]+\/callback\/[^/]+\/[^/]+$/.test(url.pathname)) return failed("invalid_callback");
  return new URL(url.pathname + url.search, origin);
}
