import { z } from "#compiled/zod/index.js";

/** HTTP(S) URL accepted as a development-server endpoint. */
export const httpServerUrlSchema = z.url({ protocol: /^https?$/ });

/**
 * Private, link-local, and otherwise reserved IP ranges that a framework-issued
 * outbound request to a caller-supplied URL must not target. This is the SSRF
 * blocklist for {@link isReservedIpAddress}.
 *
 * Loopback (`127.0.0.0/8`, `::1`) is not included so callers can decide
 * separately whether to allow it; local development servers call back to each
 * other over loopback (see {@link isBlockedDestinationHost}).
 */
const RESERVED_RANGES: readonly (readonly [cidr: string, reason: string])[] = [
  ["0.0.0.0/8", "this network / unspecified"],
  ["10.0.0.0/8", "RFC1918 private"],
  ["100.64.0.0/10", "RFC6598 carrier-grade NAT"],
  ["169.254.0.0/16", "link-local, incl. cloud metadata"],
  ["172.16.0.0/12", "RFC1918 private"],
  ["192.0.0.0/24", "IETF protocol assignments"],
  ["192.0.2.0/24", "documentation"],
  ["192.88.99.0/24", "deprecated 6to4 relay anycast"],
  ["192.168.0.0/16", "RFC1918 private"],
  ["198.18.0.0/15", "RFC2544 benchmarking"],
  ["198.51.100.0/24", "documentation"],
  ["203.0.113.0/24", "documentation"],
  ["224.0.0.0/4", "multicast"],
  ["240.0.0.0/4", "reserved and limited broadcast"],
  ["::/128", "unspecified"],
  ["::/96", "IPv4-compatible addresses"],
  ["64:ff9b::/96", "well-known NAT64 prefix"],
  ["64:ff9b:1::/48", "local-use NAT64 prefix"],
  ["100::/64", "discard-only"],
  ["2001::/23", "special-purpose"],
  ["2001:db8::/32", "documentation"],
  ["2002::/16", "6to4"],
  ["fc00::/7", "unique-local"],
  ["fe80::/10", "link-local"],
  ["ff00::/8", "multicast"],
];

const LOOPBACK_RANGES: readonly string[] = ["127.0.0.0/8", "::1/128"];

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;

/** An IP address as its bytes: 4 for IPv4, 16 for IPv6. */
type IpBytes = Uint8Array;

interface Subnet {
  readonly base: IpBytes;
  readonly prefix: number;
}

function subnet(cidr: string): Subnet {
  const slash = cidr.indexOf("/");
  const base = parseIp(cidr.slice(0, slash));
  if (base === undefined) throw new Error(`Invalid range ${cidr}.`);
  return { base, prefix: Number(cidr.slice(slash + 1)) };
}

const RESERVED = RESERVED_RANGES.map(([cidr]) => subnet(cidr));
const LOOPBACK = LOOPBACK_RANGES.map(subnet);

function inSubnet(address: IpBytes, { base, prefix }: Subnet): boolean {
  if (address.length !== base.length) return false;
  const whole = prefix >> 3;
  for (let i = 0; i < whole; i++) if (address[i] !== base[i]) return false;
  const rest = prefix & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (address[whole]! & mask) === (base[whole]! & mask);
}

function parseIpv4(text: string): IpBytes | undefined {
  return IPV4.test(text) ? new Uint8Array(text.split(".").map(Number)) : undefined;
}

function parseIpv6(text: string): IpBytes | undefined {
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groups = (half: string): number[] | undefined => {
    if (half === "") return [];
    const out: number[] = [];
    const parts = half.split(":");
    for (const [index, part] of parts.entries()) {
      // An IPv4 tail (`::ffff:1.2.3.4`) is the last two groups.
      if (index === parts.length - 1 && part.includes(".")) {
        const v4 = parseIpv4(part);
        if (v4 === undefined) return undefined;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-f]{1,4}$/iu.test(part)) {
        out.push(Number.parseInt(part, 16));
      } else {
        return undefined;
      }
    }
    return out;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (head === undefined || tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const all = [...head, ...Array<number>(missing).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  for (const [i, group] of all.entries()) {
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  }
  return bytes;
}

/**
 * `text` as IP bytes, or `undefined` when it isn't an IP literal. An IPv4-mapped IPv6 address
 * (`::ffff:169.254.169.254`, `::ffff:a9fe:a9fe`) is its IPv4 address, so the IPv4 ranges apply.
 */
function parseIp(text: string): IpBytes | undefined {
  if (!text.includes(":")) return parseIpv4(text);
  const bytes = parseIpv6(text);
  const mapped =
    bytes !== undefined &&
    bytes.subarray(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  return mapped ? bytes.subarray(12) : bytes;
}

function normalizeAddress(host: string): string {
  const withoutBrackets = host.trim().replace(/^\[(.*)\]$/u, "$1");
  const zoneIndex = withoutBrackets.indexOf("%");
  const withoutZone = zoneIndex === -1 ? withoutBrackets : withoutBrackets.slice(0, zoneIndex);

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

  const address = parseIp(normalized);
  return address !== undefined && LOOPBACK.some((range) => inSubnet(address, range));
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
 * address). Loopback is intentionally allowed (see {@link RESERVED_RANGES}).
 *
 * Plain hostnames return `false`: no DNS resolution is performed here, so a
 * hostname that resolves to a private address is not caught at this layer.
 */
export function isReservedIpAddress(host: string): boolean {
  const normalized = normalizeAddress(host);

  if (isLoopbackHostname(normalized)) {
    return false;
  }

  const address = parseIp(normalized);
  return address !== undefined && RESERVED.some((range) => inSubnet(address, range));
}

/**
 * Whether `host` is an IP literal that must not be used as the destination of
 * an untrusted outbound request. Unlike {@link isReservedIpAddress}, this also
 * blocks loopback addresses.
 */
export function isPrivateOrReservedIpAddress(host: string): boolean {
  return isLoopbackHostname(host) || isReservedIpAddress(host);
}

/**
 * Whether a framework request to an untrusted URL must not connect to
 * `host`, an IP literal, resolved address, or hostname. Hostnames are only
 * checked for the `localhost` namespace; callers must validate resolved
 * addresses at connect time.
 */
export function isBlockedDestinationHost(
  host: string,
  options: { readonly allowLoopback: boolean },
): boolean {
  return options.allowLoopback ? isReservedIpAddress(host) : isPrivateOrReservedIpAddress(host);
}
