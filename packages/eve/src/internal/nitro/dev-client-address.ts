import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { networkInterfaces } from "node:os";

import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/workflow/development-world-protocol.js";
import { isLoopbackHostname } from "#shared/network-address.js";

export const DEVELOPMENT_CLIENT_ADDRESS_HEADER = "x-eve-dev-client-address";
export const DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER = "x-eve-dev-client-address-signature";

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

export function readTrustedDevelopmentClientAddress(
  headers: Headers,
  secret: string | undefined,
): string | undefined {
  const address = headers.get(DEVELOPMENT_CLIENT_ADDRESS_HEADER);
  const signature = headers.get(DEVELOPMENT_CLIENT_ADDRESS_SIGNATURE_HEADER);
  return address !== null &&
    signature !== null &&
    isTrustedDevelopmentClientAddress(address, signature, secret)
    ? address
    : undefined;
}

export function readTrustedDevelopmentPeer(headers: Headers): "local" | "remote" | undefined {
  const address = readTrustedDevelopmentClientAddress(
    headers,
    process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV],
  );
  if (address === undefined) return undefined;
  return isLocalMachineAddress(address) ? "local" : "remote";
}

export function isLocalMachineAddress(address: string): boolean {
  if (isLoopbackHostname(address)) return true;
  const unmapped = address
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/^::ffff:/u, "");
  return Object.values(networkInterfaces()).some((entries) =>
    entries?.some((entry) => entry.address.toLowerCase() === unmapped),
  );
}

export function isTrustedDevelopmentClientAddress(
  address: string,
  signature: string,
  secret: string | undefined,
): boolean {
  return (
    address.length > 0 &&
    signature.length > 0 &&
    secret !== undefined &&
    secret.length > 0 &&
    timingSafeEqualStrings(signature, signClientAddress(address, secret))
  );
}

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
