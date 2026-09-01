import type {
  ForwardedTraceAssertion,
  TraceContentCeiling,
} from "#shared/forwarded-trace-policy.js";
import { formatTraceContentCeiling } from "#shared/forwarded-trace-policy.js";

const EVE_AUDIENCE_KEY = "eve.audience";
const CEILING_PROPERTY_KEY = "ceiling";

export type ForwardedTraceBaggage = "absent" | "malformed" | ForwardedTraceAssertion;

/** Reads Eve's audience member without interpreting or rejecting unrelated baggage. */
export function readForwardedAudienceBaggage(value: string | null): ForwardedTraceBaggage {
  if (value === null) return "absent";
  const members = baggageMembers(value).filter(isEveAudienceMember);
  if (members.length === 0) return "absent";
  if (members.length !== 1) return "malformed";
  return parseEveAudienceMember(members[0]!);
}

/** Replaces any authored Eve audience member while preserving unrelated baggage entries. */
export function writeForwardedAudienceBaggage(
  value: string | undefined,
  assertion: ForwardedTraceAssertion | undefined,
): string | undefined {
  const retained = baggageMembers(value ?? "").filter((member) => !isEveAudienceMember(member));
  if (assertion !== undefined) {
    retained.push(
      `${EVE_AUDIENCE_KEY}=${assertion.originAudience};${CEILING_PROPERTY_KEY}=${formatTraceContentCeiling(assertion.ceiling)}`,
    );
  }
  return retained.length > 0 ? retained.join(",") : undefined;
}

function baggageMembers(value: string): string[] {
  return value.split(",").map(trimOws).filter(Boolean);
}

function parseEveAudienceMember(member: string): ForwardedTraceAssertion | "malformed" {
  const segments = member.split(";");
  if (segments.length !== 2) return "malformed";

  const audiencePair = parsePair(segments[0]!);
  if (audiencePair === undefined || audiencePair.key !== EVE_AUDIENCE_KEY) return "malformed";
  const originAudience = audiencePair.value;
  if (originAudience !== "public" && originAudience !== "private" && originAudience !== "unknown") {
    return "malformed";
  }

  const ceilingPair = parsePair(segments[1]!);
  if (ceilingPair === undefined || ceilingPair.key !== CEILING_PROPERTY_KEY) return "malformed";
  const ceiling = parseCeiling(ceilingPair.value);
  return ceiling === undefined ? "malformed" : { ceiling, originAudience };
}

function parsePair(segment: string): { readonly key: string; readonly value: string } | undefined {
  const separator = segment.indexOf("=");
  if (separator <= 0 || segment.indexOf("=", separator + 1) !== -1) return undefined;
  const key = trimOws(segment.slice(0, separator));
  const value = trimOws(segment.slice(separator + 1));
  if (key.length === 0 || value.length === 0) return undefined;
  if (key !== segment.slice(0, separator).trim()) return undefined;
  if (value !== segment.slice(separator + 1).trim()) return undefined;
  return { key, value };
}

function parseCeiling(value: string): TraceContentCeiling | undefined {
  const match = /^i([01])o([01])$/u.exec(value);
  return match === null
    ? undefined
    : {
        recordInputs: match[1] === "1",
        recordOutputs: match[2] === "1",
      };
}

function trimOws(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/gu, "");
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
