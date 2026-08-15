import { BlockList, isIP } from "node:net";

import { z } from "#compiled/zod/index.js";

/** HTTP(S) URL accepted as a development-server endpoint. */
export const httpServerUrlSchema = z.url({ protocol: /^https?$/ });

/**
 * Private, link-local, and otherwise reserved IP ranges that a framework-issued
 * outbound request to a caller-supplied URL must not target. This is the SSRF
 * blocklist for {@link isReservedIpAddress}.
 *
 * Loopback (`127.0.0.0/8`, `::1`) is intentionally NOT included: it is same-host
 * rather than a network pivot, and local-dev self-callbacks use it. The
 * high-value SSRF target — cloud metadata at `169.254.169.254` — is link-local
 * and IS blocked here.
 */
const reservedRanges = new BlockList();
reservedRanges.addSubnet("0.0.0.0", 8, "ipv4"); // "this network" / unspecified
reservedRanges.addSubnet("10.0.0.0", 8, "ipv4"); // RFC1918 private
reservedRanges.addSubnet("100.64.0.0", 10, "ipv4"); // RFC6598 carrier-grade NAT
reservedRanges.addSubnet("169.254.0.0", 16, "ipv4"); // link-local incl. cloud metadata
reservedRanges.addSubnet("172.16.0.0", 12, "ipv4"); // RFC1918 private
reservedRanges.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
reservedRanges.addSubnet("192.0.2.0", 24, "ipv4"); // documentation
reservedRanges.addSubnet("192.88.99.0", 24, "ipv4"); // deprecated 6to4 relay anycast
reservedRanges.addSubnet("192.168.0.0", 16, "ipv4"); // RFC1918 private
reservedRanges.addSubnet("198.18.0.0", 15, "ipv4"); // RFC2544 benchmarking
reservedRanges.addSubnet("198.51.100.0", 24, "ipv4"); // documentation
reservedRanges.addSubnet("203.0.113.0", 24, "ipv4"); // documentation
reservedRanges.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
reservedRanges.addSubnet("240.0.0.0", 4, "ipv4"); // reserved and limited broadcast
reservedRanges.addAddress("::", "ipv6"); // unspecified
reservedRanges.addSubnet("::", 96, "ipv6"); // IPv4-compatible addresses
reservedRanges.addSubnet("64:ff9b::", 96, "ipv6"); // well-known NAT64 prefix
reservedRanges.addSubnet("64:ff9b:1::", 48, "ipv6"); // local-use NAT64 prefix
reservedRanges.addSubnet("100::", 64, "ipv6"); // discard-only
reservedRanges.addSubnet("2001::", 23, "ipv6"); // special-purpose
reservedRanges.addSubnet("2001:db8::", 32, "ipv6"); // documentation
reservedRanges.addSubnet("2002::", 16, "ipv6"); // 6to4
reservedRanges.addSubnet("fc00::", 7, "ipv6"); // unique-local
reservedRanges.addSubnet("fe80::", 10, "ipv6"); // link-local
reservedRanges.addSubnet("ff00::", 8, "ipv6"); // multicast

const loopbackRanges = new BlockList();
loopbackRanges.addSubnet("127.0.0.0", 8, "ipv4");
loopbackRanges.addAddress("::1", "ipv6");

function normalizeAddress(host: string): string {
  const withoutBrackets = host.trim().replace(/^\[(.*)\]$/u, "$1");
  const zoneIndex = withoutBrackets.indexOf("%");
  const withoutZone = zoneIndex === -1 ? withoutBrackets : withoutBrackets.slice(0, zoneIndex);

  // Unwrap IPv4-mapped IPv6 (`::ffff:169.254.169.254`) so the IPv4 ranges apply.
  if (withoutZone.toLowerCase().startsWith("::ffff:")) {
    const candidate = withoutZone.slice("::ffff:".length);
    if (isIP(candidate) === 4) {
      return candidate;
    }
  }

  return withoutZone;
}

/**
 * Returns whether `hostname` names the current machine's loopback interface.
 * Accepts the full IPv4 loopback block, IPv6 loopback, and the RFC 6761
 * `localhost` namespace. Wildcard bind addresses such as `0.0.0.0` are not
 * loopback connect targets.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeAddress(hostname).toLowerCase().replace(/\.$/u, "");

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const family = isIP(normalized);
  return family !== 0 && loopbackRanges.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

/** Returns whether `urlText` is an HTTP(S) URL with a loopback hostname. */
export function isLoopbackServerUrl(urlText: string): boolean {
  const parsed = httpServerUrlSchema.safeParse(urlText);
  return parsed.success && isLoopbackHostname(new URL(parsed.data).hostname);
}

/**
 * Whether `host` is an IP literal in a private, link-local, or otherwise
 * reserved range that an outbound framework request must not target — an SSRF
 * guard for caller-supplied URLs (covers RFC1918, CGNAT, link-local incl. cloud
 * metadata at `169.254.169.254`, IPv6 ULA/link-local, and the unspecified
 * address). Loopback is intentionally allowed (see {@link reservedRanges}).
 *
 * Plain hostnames return `false`: no DNS resolution is performed here, so a
 * hostname that resolves to a private address is not caught at this layer.
 */
export function isReservedIpAddress(host: string): boolean {
  const normalized = normalizeAddress(host);

  if (isLoopbackHostname(normalized)) {
    return false;
  }

  const family = isIP(normalized);
  if (family === 0) {
    return false;
  }
  return reservedRanges.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Whether `host` is an IP literal that must not be used as the destination of
 * an untrusted outbound request. Unlike {@link isReservedIpAddress}, this also
 * blocks loopback addresses.
 */
export function isPrivateOrReservedIpAddress(host: string): boolean {
  return isLoopbackHostname(host) || isReservedIpAddress(host);
}
