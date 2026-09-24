import {
  resolveForwardedPrincipal,
  type ForwardedPrincipal,
  type TrustedForwarders,
} from "#channel/forwarded-principal.js";
import type { SessionAuthContext } from "#channel/types.js";
import {
  directCapabilityPrincipals,
  type CapabilityPrincipals,
} from "#execution/capability-session.js";

export type { ForwardedPrincipal, TrustedForwarders };

/** Request header carrying a forwarded principal, encoded with {@link encodeForwardedPrincipalHeader}. */
export const FORWARDED_PRINCIPAL_HEADER = "eve-forwarded-principal";
const FORWARDED_PRINCIPAL_HEADER_MAX_LENGTH = 16 * 1024;

/**
 * Encodes a forwarded principal for the `eve-forwarded-principal` header:
 * base64url of the JSON `{ current, initiator? }` shape. Send only principal
 * metadata, never tokens.
 */
export function encodeForwardedPrincipalHeader(principal: ForwardedPrincipal): string {
  return Buffer.from(JSON.stringify(principal), "utf8").toString("base64url");
}

/**
 * Applies eveChannel's forwarded-principal gate to the header: absent keeps
 * the route-auth caller; untrusted or unconfigured is 403; malformed is 400;
 * a throwing predicate is 500.
 */
export async function resolveCapabilityPrincipals(
  request: Request,
  forwarder: SessionAuthContext,
  trustedForwarders: TrustedForwarders | undefined,
): Promise<CapabilityPrincipals | Response> {
  const header = request.headers.get(FORWARDED_PRINCIPAL_HEADER);
  if (header === null) return directCapabilityPrincipals(forwarder);

  const decoded = decodeForwardedPrincipalHeader(header);
  if (!decoded.ok && trustedForwarders !== undefined) {
    return forwardedPrincipalError(400, decoded.message);
  }
  const resolved = await resolveForwardedPrincipal({
    forwarder,
    payload: { forwardedPrincipal: decoded.ok ? decoded.value : header },
    trustedForwarders,
  });
  if (resolved instanceof Response) {
    if (resolved.status !== 400) return resolved;
    const body = readRecord(await resolved.json());
    return forwardedPrincipalError(
      400,
      typeof body?.error === "string" ? body.error : "Invalid forwarded principal.",
    );
  }
  if (!resolved.accepted) return directCapabilityPrincipals(forwarder);
  return { current: resolved.auth, forwarder, initiator: resolved.initiatorAuth };
}

function decodeForwardedPrincipalHeader(
  header: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly message: string; readonly ok: false } {
  const value = header.trim();
  if (value.length === 0 || value.length > FORWARDED_PRINCIPAL_HEADER_MAX_LENGTH) {
    return {
      message: `must be 1 to ${String(FORWARDED_PRINCIPAL_HEADER_MAX_LENGTH)} characters.`,
      ok: false,
    };
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(value)) {
    return { message: "must be base64url-encoded JSON.", ok: false };
  }
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64url"));
    return { ok: true, value: JSON.parse(json) };
  } catch {
    return { message: "must decode to UTF-8 JSON.", ok: false };
  }
}

function forwardedPrincipalError(status: 400, message: string): Response {
  return Response.json(
    { error: `Invalid ${FORWARDED_PRINCIPAL_HEADER} header: ${message}`, ok: false },
    { status },
  );
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
