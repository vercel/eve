import { BlockList, isIP } from "node:net";

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
reservedRanges.addSubnet("192.168.0.0", 16, "ipv4"); // RFC1918 private
reservedRanges.addSubnet("198.18.0.0", 15, "ipv4"); // RFC2544 benchmarking
reservedRanges.addAddress("::", "ipv6"); // unspecified
reservedRanges.addSubnet("fc00::", 7, "ipv6"); // unique-local
reservedRanges.addSubnet("fe80::", 10, "ipv6"); // link-local

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
  const family = isIP(normalized);
  if (family === 0) {
    return false;
  }
  return reservedRanges.check(normalized, family === 4 ? "ipv4" : "ipv6");
}
