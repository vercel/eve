import type {
  ForwardedTraceAssertion,
  TraceContentCeiling,
} from "#shared/forwarded-trace-policy.js";
import { formatTraceContentCeiling } from "#shared/forwarded-trace-policy.js";
import type { SessionParent } from "#channel/types.js";

const EVE_AUDIENCE_KEY = "eve.audience";
const EVE_PARENT_SESSION_KEY = "eve.parent_session";
const CEILING_PROPERTY_KEY = "ceiling";
const MAX_BAGGAGE_BYTES = 8192;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

interface BaggageProperty {
  readonly key: string;
  readonly value?: string;
}

interface BaggageMember {
  readonly value: string;
  readonly properties: readonly BaggageProperty[];
}

export type ForwardedTraceBaggage = "absent" | "malformed" | ForwardedTraceAssertion;
export type ForwardedParentSessionBaggage = "absent" | "malformed" | SessionParent;

/** Reads remote parent lineage without trusting the caller that supplied it. */
export function readForwardedParentSessionBaggage(
  value: string | null,
): ForwardedParentSessionBaggage {
  const member = readBaggageMember(value, EVE_PARENT_SESSION_KEY);
  if (typeof member === "string") return member;
  if (member.properties.length !== 0) return "malformed";
  let parsed: unknown;
  try {
    parsed = JSON.parse(member.value);
  } catch {
    return "malformed";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "malformed";
  const parent = parsed as Partial<SessionParent>;
  const turn = parent.turn;
  if (
    typeof parent.callId !== "string" ||
    parent.callId.length === 0 ||
    typeof parent.rootSessionId !== "string" ||
    parent.rootSessionId.length === 0 ||
    typeof parent.sessionId !== "string" ||
    parent.sessionId.length === 0 ||
    turn === undefined ||
    typeof turn.id !== "string" ||
    turn.id.length === 0 ||
    !Number.isSafeInteger(turn.sequence) ||
    turn.sequence < 0
  ) {
    return "malformed";
  }
  return {
    callId: parent.callId,
    rootSessionId: parent.rootSessionId,
    sessionId: parent.sessionId,
    turn: { id: turn.id, sequence: turn.sequence },
  };
}

/** Replaces Eve's remote parent lineage while preserving unrelated baggage. */
export function writeForwardedParentSessionBaggage(
  value: string | undefined,
  parent: SessionParent | undefined,
): string | undefined {
  return replaceBaggageMember(
    value,
    EVE_PARENT_SESSION_KEY,
    parent === undefined ? undefined : encodeURIComponent(JSON.stringify(parent)),
  );
}

/** Reads eve's audience member without interpreting unrelated baggage. */
export function readForwardedAudienceBaggage(value: string | null): ForwardedTraceBaggage {
  const member = readBaggageMember(value, EVE_AUDIENCE_KEY);
  if (typeof member === "string") return member;
  const originAudience = member.value;
  if (originAudience !== "public" && originAudience !== "private" && originAudience !== "unknown") {
    return "malformed";
  }
  const property = member.properties[0];
  if (member.properties.length !== 1 || property?.key !== CEILING_PROPERTY_KEY) return "malformed";
  const ceiling = property.value === undefined ? undefined : parseCeiling(property.value);
  return ceiling === undefined ? "malformed" : { ceiling, originAudience };
}

/** Replaces any authored eve audience member while preserving unrelated baggage entries. */
export function writeForwardedAudienceBaggage(
  value: string | undefined,
  assertion: ForwardedTraceAssertion | undefined,
): string | undefined {
  return replaceBaggageMember(
    value,
    EVE_AUDIENCE_KEY,
    assertion === undefined
      ? undefined
      : `${assertion.originAudience};${CEILING_PROPERTY_KEY}=${formatTraceContentCeiling(assertion.ceiling)}`,
  );
}

/** Recognized members are singular; malformed or oversized input fails closed. */
export function readBaggageMember(
  value: string | null,
  key: string,
): BaggageMember | "absent" | "malformed" {
  if (value === null) return "absent";
  if (value.length > MAX_BAGGAGE_BYTES || encoder.encode(value).byteLength > MAX_BAGGAGE_BYTES) {
    return "malformed";
  }
  const members = baggageMembers(value).filter((member) => baggageKey(member) === key);
  if (members.length === 0) return "absent";
  if (members.length !== 1) return "malformed";
  const [head, ...segments] = members[0]!.split(";");
  const pair = parsePair(head!);
  if (pair?.value === undefined) return "malformed";
  const properties: BaggageProperty[] = [];
  for (const segment of segments) {
    const property = parsePair(segment);
    if (property === undefined) return "malformed";
    properties.push(property);
  }
  return { value: pair.value, properties };
}

/** Replaces a member with an encoded value and optional properties; undefined removes it. */
export function replaceBaggageMember(
  value: string | undefined,
  key: string,
  member: string | undefined,
): string | undefined {
  const retained = baggageMembers(value ?? "").filter((entry) => baggageKey(entry) !== key);
  if (member !== undefined) {
    const result = [...retained, `${key}=${member}`].join(",");
    if (encoder.encode(result).byteLength > MAX_BAGGAGE_BYTES) {
      throw new Error(
        "Cannot forward baggage: header exceeds 8192 bytes. Reduce remote.headers.baggage.",
      );
    }
    return result;
  }
  return retained.join(",") || undefined;
}

function baggageMembers(value: string): string[] {
  return value.split(",").map(trimOws).filter(Boolean);
}

function parsePair(segment: string): BaggageProperty | undefined {
  const separator = segment.indexOf("=");
  const key = trimOws(separator < 0 ? segment : segment.slice(0, separator));
  if (!/^[!#$%&'*+\-.^_`|~\w]+$/u.test(key)) return undefined;
  if (separator < 0) return { key };
  const value = trimOws(segment.slice(separator + 1));
  if (
    !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/u.test(value) ||
    /%(?![\da-f]{2})/iu.test(value)
  ) {
    return undefined;
  }
  const bytes = Uint8Array.from(value.match(/%[\da-f]{2}|./giu) ?? [], (octet) =>
    octet.startsWith("%") ? Number.parseInt(octet.slice(1), 16) : octet.charCodeAt(0),
  );
  return { key, value: decoder.decode(bytes) };
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

function baggageKey(member: string): string {
  const pair = member.split(";", 1)[0]!;
  const separator = pair.indexOf("=");
  return (separator < 0 ? pair : pair.slice(0, separator)).trim();
}
