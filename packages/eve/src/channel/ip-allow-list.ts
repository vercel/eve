import { BlockList, isIP } from "node:net";

/**
 * Parsed runtime-owned IP allowlist.
 */
export interface RuntimeIpAllowList {
  readonly blockList: BlockList;
  readonly entries: readonly string[];
}

/**
 * Parses exact IP and CIDR entries into a reusable runtime-owned allowlist.
 */
export function createRuntimeIpAllowList(entries: readonly string[]): RuntimeIpAllowList {
  const blockList = new BlockList();

  for (const rawEntry of entries) {
    const entry = rawEntry.trim();

    if (entry.length === 0) {
      throw new Error("Expected every network.ipAllowList entry to be non-empty.");
    }

    if (entry.includes("*")) {
      throw new Error(`Expected "${entry}" to use exact IP or CIDR syntax instead of "*".`);
    }

    const slashIndex = entry.indexOf("/");

    if (slashIndex === -1) {
      const normalizedAddress = normalizeIpAddress(entry);
      const family = getIpFamily(normalizedAddress);

      blockList.addAddress(normalizedAddress, family);
      continue;
    }

    const address = normalizeIpAddress(entry.slice(0, slashIndex));
    const prefix = Number.parseInt(entry.slice(slashIndex + 1), 10);
    const family = getIpFamily(address);
    const maxPrefix = family === "ipv4" ? 32 : 128;

    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      throw new Error(`Expected "${entry}" to use a valid ${family} CIDR prefix length.`);
    }

    blockList.addSubnet(address, prefix, family);
  }

  return {
    blockList,
    entries: [...entries],
  };
}

/**
 * Returns whether the normalized request IP matches at least one allowlist
 * entry.
 */
export function isRuntimeIpAllowed(address: string, allowList: RuntimeIpAllowList): boolean {
  const normalizedAddress = normalizeIpAddress(address);
  const family = getIpFamily(normalizedAddress);

  return allowList.blockList.check(normalizedAddress, family);
}

function normalizeIpAddress(value: string): string {
  const trimmed = value.trim().replace(/^\[(.*)\]$/, "$1");
  const percentIndex = trimmed.indexOf("%");
  const withoutZone = percentIndex === -1 ? trimmed : trimmed.slice(0, percentIndex);

  if (withoutZone.startsWith("::ffff:")) {
    const candidate = withoutZone.slice("::ffff:".length);

    if (isIP(candidate) === 4) {
      return candidate;
    }
  }

  return withoutZone;
}

function getIpFamily(address: string): "ipv4" | "ipv6" {
  switch (isIP(address)) {
    case 4:
      return "ipv4";
    case 6:
      return "ipv6";
    default:
      throw new Error(`Expected "${address}" to be a valid IP address.`);
  }
}
