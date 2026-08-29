/**
 * Protocol constants and identity plumbing shared by the UCP connection
 * preset and the checkout-handoff contract.
 */

/**
 * UCP specification version this preset targets by default.
 *
 * UCP versions are dated (`YYYY-MM-DD`) and a business advertises the
 * versions it accepts in its `/.well-known/ucp` profile. Override it per
 * connection when a merchant has not yet adopted this one.
 */
export const UCP_VERSION = "2026-04-08";

/** Canonical URL of the UCP shopping REST contract for a given version. */
export function ucpShoppingRestSpecUrl(version: string = UCP_VERSION): string {
  return `https://ucp.dev/${version}/services/shopping/rest.openapi.json`;
}

/**
 * Identity a UCP platform (the calling agent) advertises on every
 * request.
 *
 * UCP has no registration step: a business resolves who is calling by
 * fetching the `profile` document named here, then reads its declared
 * capabilities and its `signing_keys` to verify signatures. The profile
 * must therefore be reachable over HTTPS from the merchant's network —
 * a `localhost` dev server is not, which is why merchants publish
 * example agent profiles for local testing.
 */
export interface UcpAgentMetadata {
  /** Absolute HTTPS URL of this agent's UCP profile document. */
  readonly profile: string;
  /**
   * Extra `UCP-Agent` dictionary members, serialized as quoted strings.
   *
   * The spec requires `profile` and allows platforms to add their own
   * members; anything here is appended verbatim after it.
   */
  readonly parameters?: Readonly<Record<string, string>>;
}

/**
 * Serializes {@link UcpAgentMetadata} into a `UCP-Agent` header value —
 * an RFC 8941 dictionary whose `profile` member is a quoted string.
 *
 * @throws when `profile` is not an absolute `https` URL, which the spec
 * requires and verifiers reject.
 */
export function ucpAgentHeaderValue(agent: UcpAgentMetadata): string {
  let url: URL;
  try {
    url = new URL(agent.profile);
  } catch {
    throw new Error(
      `UCP agent profile must be an absolute https URL, got "${agent.profile}". Publish the profile on a host the merchant can reach.`,
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `UCP agent profile must use https, got "${url.protocol}//${url.host}". Merchants reject non-https profile URLs.`,
    );
  }

  const members = [`profile="${escapeDictionaryString(agent.profile)}"`];
  for (const [key, value] of Object.entries(agent.parameters ?? {})) {
    members.push(`${key}="${escapeDictionaryString(value)}"`);
  }
  return members.join(", ");
}

function escapeDictionaryString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Derives a stable UUID from `seed`.
 *
 * UCP requires retry-safe request identifiers with at least 128 bits of
 * entropy, and its REST contract types them as UUIDs. Deriving them from
 * eve's replay-stable `callId` rather than minting random ones is what
 * makes them retry-safe: a durable turn that resumes and re-issues the
 * same tool call sends the same key, so the merchant replays its cached
 * response instead of charging twice.
 *
 * The result is a version 8 (custom) UUID over the SHA-256 of `seed`.
 */
export async function deriveUcpRequestUuid(seed: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  );
  const bytes = digest.slice(0, 16);
  // RFC 9562: version in the high nibble of octet 6, variant in the two
  // high bits of octet 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
