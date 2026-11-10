import type { SessionAuthContext } from "#channel/types.js";
import { WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { EVE_ATTRIBUTE_VALUE_MAX_BYTES } from "#runtime/attributes/normalize.js";
import { walkCauseChain } from "#shared/errors.js";

/**
 * Creation identity, recorded as `$eve.creator.*` run attributes. `start()`
 * writes them with the run, so a concurrent or retried creation that answers
 * with an existing session ID names a session whose creator is already
 * readable. Only identity fields are recorded; `attributes` are not.
 */
const CREATOR_TYPE_ATTRIBUTE = "$eve.creator.type";
const ANONYMOUS_CREATOR = "anonymous";

const CREATOR_FIELD_ATTRIBUTES = {
  authenticator: "$eve.creator.authenticator",
  issuer: "$eve.creator.issuer",
  principalId: "$eve.creator.id",
  subject: "$eve.creator.subject",
} as const;

type CreatorField = keyof typeof CREATOR_FIELD_ATTRIBUTES;

export class SessionCreatorTooLongError extends Error {
  constructor(field: string) {
    super(
      `Session creator ${field} exceeds ${EVE_ATTRIBUTE_VALUE_MAX_BYTES} bytes and cannot be recorded.`,
    );
    this.name = "SessionCreatorTooLongError";
  }
}

export function buildSessionCreatorAttributes(
  creator: SessionAuthContext | null,
): Record<string, string> {
  if (creator === null || creator.principalType === ANONYMOUS_CREATOR) {
    return { [CREATOR_TYPE_ATTRIBUTE]: ANONYMOUS_CREATOR };
  }
  const attributes: Record<string, string> = { [CREATOR_TYPE_ATTRIBUTE]: creator.principalType };
  for (const field of Object.keys(CREATOR_FIELD_ATTRIBUTES) as CreatorField[]) {
    const value = creator[field];
    if (value !== undefined) attributes[CREATOR_FIELD_ATTRIBUTES[field]] = value;
  }
  const encoder = new TextEncoder();
  for (const [attribute, value] of Object.entries(attributes)) {
    if (encoder.encode(value).length > EVE_ATTRIBUTE_VALUE_MAX_BYTES) {
      throw new SessionCreatorTooLongError(attribute.slice("$eve.creator.".length));
    }
  }
  return attributes;
}

export function sessionCreatorFromAttributes(
  attributes: Readonly<Record<string, string>>,
): SessionAuthContext | null | undefined {
  const principalType = attributes[CREATOR_TYPE_ATTRIBUTE];
  if (principalType === undefined) return undefined;
  if (principalType === ANONYMOUS_CREATOR) return null;
  const authenticator = attributes[CREATOR_FIELD_ATTRIBUTES.authenticator];
  const principalId = attributes[CREATOR_FIELD_ATTRIBUTES.principalId];
  if (authenticator === undefined || principalId === undefined) return undefined;
  const issuer = attributes[CREATOR_FIELD_ATTRIBUTES.issuer];
  const subject = attributes[CREATOR_FIELD_ATTRIBUTES.subject];
  return {
    attributes: {},
    authenticator,
    ...(issuer !== undefined && { issuer }),
    principalId,
    principalType,
    ...(subject !== undefined && { subject }),
  };
}

export async function readSessionCreator(
  sessionId: string,
): Promise<SessionAuthContext | null | undefined> {
  const world = await getWorld();
  try {
    const run = await world.runs.get(sessionId, { resolveData: "none" });
    return sessionCreatorFromAttributes(run.attributes);
  } catch (error) {
    for (const cause of walkCauseChain(error)) {
      if (WorkflowRunNotFoundError.is(cause)) return undefined;
    }
    throw error;
  }
}
