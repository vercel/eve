const EVE_AUDIENCE_KEY = "eve.audience";
const PUBLIC_AUDIENCE_MEMBER = `${EVE_AUDIENCE_KEY}=public`;

export const FORWARDED_AUDIENCE_SOURCE_KEY = "eve.trace.audience_source";
export const FORWARDED_AUDIENCE_SOURCE = "trusted-forwarder";

export type ForwardedAudienceBaggage = "absent" | "malformed" | "public";

/** Reads Eve's audience member without interpreting or rejecting unrelated baggage. */
export function readForwardedAudienceBaggage(value: string | null): ForwardedAudienceBaggage {
  if (value === null) return "absent";
  const members = baggageMembers(value).filter(isEveAudienceMember);
  if (members.length === 0) return "absent";
  if (members.length !== 1) return "malformed";
  return members[0] === PUBLIC_AUDIENCE_MEMBER ? "public" : "malformed";
}

/** Replaces any authored Eve audience member while preserving unrelated baggage entries. */
export function writeForwardedAudienceBaggage(
  value: string | undefined,
  audience: "public" | "unknown",
): string | undefined {
  const retained = baggageMembers(value ?? "").filter((member) => !isEveAudienceMember(member));
  if (audience === "public") retained.push(PUBLIC_AUDIENCE_MEMBER);
  return retained.length > 0 ? retained.join(",") : undefined;
}

function baggageMembers(value: string): string[] {
  return value
    .split(",")
    .map((member) => member.trim())
    .filter(Boolean);
}

function baggageKey(member: string): string | undefined {
  const pair = member.split(";", 1)[0]!;
  const separator = pair.indexOf("=");
  return separator > 0 ? pair.slice(0, separator).trim() : undefined;
}

function isEveAudienceMember(member: string): boolean {
  const pair = member.split(";", 1)[0]!;
  return (baggageKey(member) ?? pair.trim()) === EVE_AUDIENCE_KEY;
}
