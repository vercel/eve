import {
  resolveForwardedPrincipal,
  type ForwardedPrincipal,
  type TrustedForwarders,
} from "#channel/forwarded-principal.js";
import type { SessionAuthContext } from "#channel/types.js";

/** Request header carrying a forwarded principal on MCP requests. */
export const FORWARDED_PRINCIPAL_HEADER = "eve-forwarded-principal";

/** Largest accepted encoded header value. */
export const FORWARDED_PRINCIPAL_HEADER_MAX_BYTES = 16 * 1024;

const BASE64URL_UNPADDED = /^[A-Za-z0-9_-]+$/;

/** The principals one MCP request's published tools run as. */
export interface McpRequestPrincipals {
  /** The route-auth principal, or the accepted forwarded `current`. */
  readonly current: SessionAuthContext;
  /** The accepted forwarded initiator, or `current` when none was forwarded. */
  readonly initiator: SessionAuthContext;
  /** The verified route principal that forwarded `current`, when one did. */
  readonly forwarder?: SessionAuthContext;
}

/**
 * Resolves the `eve-forwarded-principal` header against the channel's
 * `trustedForwarders`, sharing parsing, stamping, and the predicate with
 * eveChannel's `forwardedPrincipal` body field.
 *
 * A header the channel cannot accept is a 403 rather than ignored: running the
 * call as the forwarder instead would silently widen it to the forwarder's
 * access. An anonymous route principal cannot forward, since no one is
 * accountable for the assertion. A malformed or oversized header is a 400.
 */
export async function resolveMcpRequestPrincipals(
  request: Request,
  routePrincipal: SessionAuthContext,
  trustedForwarders: TrustedForwarders | undefined,
): Promise<McpRequestPrincipals | Response> {
  const header = request.headers.get(FORWARDED_PRINCIPAL_HEADER);
  if (header === null) return { current: routePrincipal, initiator: routePrincipal };
  if (trustedForwarders === undefined) {
    return failure(403, "This deployment does not accept a forwarded principal.");
  }
  if (routePrincipal.principalType === "anonymous") {
    return failure(403, "An anonymous caller cannot forward a principal. Authenticate it.");
  }
  const decoded = decodeHeader(header);
  if (typeof decoded === "string") return failure(400, decoded);

  const resolved = await resolveForwardedPrincipal({
    forwarder: routePrincipal,
    payload: { forwardedPrincipal: decoded.value },
    trustedForwarders,
  });
  if (resolved instanceof Response) return resolved;
  if (!resolved.accepted) return { current: routePrincipal, initiator: routePrincipal };
  // resolveForwardedPrincipal already stamped both with `eve:forwarded-by`.
  return { current: resolved.auth, forwarder: routePrincipal, initiator: resolved.initiatorAuth };
}

/**
 * Encodes a principal for the header, failing before the request when the
 * receiving channel would refuse it as oversized.
 */
export function encodeForwardedPrincipalHeader(
  principal: ForwardedPrincipal,
  connectionName: string,
): string {
  const encoded = Buffer.from(JSON.stringify(principal), "utf8").toString("base64url");
  if (encoded.length > FORWARDED_PRINCIPAL_HEADER_MAX_BYTES) {
    throw new Error(
      `Connection "${connectionName}" cannot forward the caller's principal: the ` +
        `${FORWARDED_PRINCIPAL_HEADER} header would be ${encoded.length} bytes, over the ` +
        `${FORWARDED_PRINCIPAL_HEADER_MAX_BYTES}-byte limit. Trim the principal's attributes.`,
    );
  }
  return encoded;
}

/** Unpadded base64url of UTF-8 JSON, at most 16 KiB encoded; a string is the failure. */
function decodeHeader(value: string): { readonly value: unknown } | string {
  if (value.length > FORWARDED_PRINCIPAL_HEADER_MAX_BYTES) {
    return `The ${FORWARDED_PRINCIPAL_HEADER} header must be at most ${FORWARDED_PRINCIPAL_HEADER_MAX_BYTES} bytes.`;
  }
  if (!BASE64URL_UNPADDED.test(value) || value.length % 4 === 1) {
    return `The ${FORWARDED_PRINCIPAL_HEADER} header must be unpadded base64url.`;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64url"));
    return { value: JSON.parse(text) as unknown };
  } catch {
    return `The ${FORWARDED_PRINCIPAL_HEADER} header must encode UTF-8 JSON.`;
  }
}

function failure(status: 400 | 403, error: string): Response {
  return Response.json({ error, ok: false }, { status });
}
