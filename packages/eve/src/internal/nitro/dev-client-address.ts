import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const DEVELOPMENT_CLIENT_ADDRESS_HEADER = "x-eve-dev-client-address";
export const DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER = "x-eve-dev-client-address-signature";

/**
 * Stamps the accepted socket's peer address onto a request bound for the
 * dev worker. Public copies of the metadata headers are dropped first, and
 * the value is signed with the per-process dev transport secret: the
 * worker's own HTTP port is reachable by other local processes, so an
 * unsigned header could be forged by anything that discovers it.
 */
export function stampDevelopmentClientAddress(
  headers: Headers | IncomingHttpHeaders,
  address: string | undefined,
  secret: string | undefined,
): void {
  deleteHeader(headers, DEVELOPMENT_CLIENT_ADDRESS_HEADER);
  deleteHeader(headers, DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER);
  if (
    address === undefined ||
    address.length === 0 ||
    secret === undefined ||
    secret.length === 0
  ) {
    return;
  }
  setHeader(headers, DEVELOPMENT_CLIENT_ADDRESS_HEADER, address);
  setHeader(
    headers,
    DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER,
    signClientAddress(address, secret),
  );
}

/**
 * Returns the parent-stamped client address when its signature verifies,
 * `undefined` otherwise. Callers fall back to the socket peer, which in the
 * proxied dev topology is the parent's loopback hop.
 */
export function readTrustedDevelopmentClientAddress(
  headers: Headers,
  secret: string | undefined,
): string | undefined {
  const address = headers.get(DEVELOPMENT_CLIENT_ADDRESS_HEADER);
  const signature = headers.get(DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER);
  if (
    address === null ||
    signature === null ||
    secret === undefined ||
    secret.length === 0 ||
    !timingSafeEqualStrings(signature, signClientAddress(address, secret))
  ) {
    return undefined;
  }
  return address;
}

/**
 * Constant-time string comparison over fixed-length digests, so neither the
 * length nor the content of a secret comparison leaks through timing.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function signClientAddress(address: string, secret: string): string {
  return createHmac("sha256", secret).update(address).digest("base64url");
}

function deleteHeader(headers: Headers | IncomingHttpHeaders, name: string): void {
  if (headers instanceof Headers) {
    headers.delete(name);
    return;
  }
  delete headers[name];
}

function setHeader(headers: Headers | IncomingHttpHeaders, name: string, value: string): void {
  if (headers instanceof Headers) {
    headers.set(name, value);
    return;
  }
  headers[name] = value;
}
