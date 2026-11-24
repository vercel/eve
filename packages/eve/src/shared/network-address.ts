import { z } from "#compiled/zod/index.js";

export const httpServerUrlSchema = z.url({ protocol: /^https?$/ });

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

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeAddress(hostname).toLowerCase().replace(/\.$/u, "");

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const address = parseIp(normalized);
  return address !== undefined && LOOPBACK.some((range) => inSubnet(address, range));
}

export function isLoopbackServerUrl(urlText: string): boolean {
  const parsed = httpServerUrlSchema.safeParse(urlText);
  return parsed.success && isLoopbackHostname(new URL(parsed.data).hostname);
}

export function isReservedIpAddress(host: string): boolean {
  const normalized = normalizeAddress(host);

  if (isLoopbackHostname(normalized)) {
    return false;
  }

  const address = parseIp(normalized);
  return address !== undefined && RESERVED.some((range) => inSubnet(address, range));
}

export function isPrivateOrReservedIpAddress(host: string): boolean {
  return isLoopbackHostname(host) || isReservedIpAddress(host);
}

export function isBlockedDestinationHost(
  host: string,
  options: { readonly allowLoopback: boolean },
): boolean {
  return options.allowLoopback ? isReservedIpAddress(host) : isPrivateOrReservedIpAddress(host);
}
