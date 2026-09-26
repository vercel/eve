import type {
  AuthorizationCompletedStreamEvent,
  AuthorizationRequiredStreamEvent,
} from "#protocol/message.js";
import type { EveAuthorizationPart } from "#client/message-reducer-types.js";

type MutableAuthorizationPart<T extends EveAuthorizationPart> = {
  -readonly [K in keyof T]: T[K];
};

export function createAuthorizationRequiredPart(
  event: AuthorizationRequiredStreamEvent,
): EveAuthorizationPart {
  const displayName =
    event.data.authorization?.displayName ?? formatAuthorizationDisplayName(event.data.name);

  const part: MutableAuthorizationPart<
    Extract<EveAuthorizationPart, { state: "required" | "pending" }>
  > = {
    authorization: event.data.authorization,
    description: normalizeAuthorizationDescription(
      event.data.description,
      event.data.name,
      displayName,
    ),
    displayName,
    name: event.data.name,
    state: "required",
    stepIndex: event.data.stepIndex,
    turnId: event.data.turnId,
    type: "authorization",
  };
  if (event.data.attemptId !== undefined) part.attemptId = event.data.attemptId;
  if (event.data.webhookUrl !== undefined) part.awaitsCallback = true;
  return part;
}

export function createAuthorizationCompletedPart(
  event: AuthorizationCompletedStreamEvent,
  existing?: EveAuthorizationPart,
): EveAuthorizationPart {
  const displayName =
    event.data.authorization?.displayName ??
    existing?.displayName ??
    formatAuthorizationDisplayName(event.data.name);

  const part: MutableAuthorizationPart<Extract<EveAuthorizationPart, { state: "completed" }>> = {
    authorization:
      existing?.authorization || event.data.authorization
        ? { ...existing?.authorization, ...event.data.authorization }
        : undefined,
    description:
      existing?.description ??
      buildCompletedAuthorizationDescription(displayName, event.data.outcome, event.data.reason),
    displayName,
    name: event.data.name,
    outcome: event.data.outcome,
    state: "completed",
    stepIndex: existing?.stepIndex ?? event.data.stepIndex,
    turnId: existing?.turnId ?? event.data.turnId,
    type: "authorization",
  };
  const attemptId = event.data.attemptId ?? existing?.attemptId;
  if (attemptId !== undefined) part.attemptId = attemptId;
  if (existing?.awaitsCallback) part.awaitsCallback = true;
  if (event.data.reason !== undefined) part.reason = event.data.reason;
  return part;
}

function buildCompletedAuthorizationDescription(
  displayName: string,
  outcome: AuthorizationCompletedStreamEvent["data"]["outcome"],
  reason?: string,
): string {
  if (outcome === "authorized") {
    return `${displayName} connected.`;
  }

  const tail = reason !== undefined ? ` (${reason})` : "";
  return `${displayName} authorization ${outcome}${tail}.`;
}

function normalizeAuthorizationDescription(
  description: string,
  name: string,
  displayName: string,
): string {
  if (description === `Authorization required for ${name}`) {
    return `Authorization required for ${displayName}`;
  }

  return description;
}

function formatAuthorizationDisplayName(name: string): string {
  if (name.length === 0) {
    return name;
  }

  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}
