import type {
  AuthorizationCompletedStreamEvent,
  AuthorizationRequiredStreamEvent,
} from "#protocol/message.js";
import type { EveAuthorizationPart } from "#client/message-reducer-types.js";

export function createAuthorizationRequiredPart(
  event: AuthorizationRequiredStreamEvent,
): EveAuthorizationPart {
  const displayName =
    event.data.authorization?.displayName ?? formatAuthorizationDisplayName(event.data.name);

  return {
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
}

export function createAuthorizationCompletedPart(
  event: AuthorizationCompletedStreamEvent,
  existing?: EveAuthorizationPart,
): EveAuthorizationPart {
  const displayName =
    event.data.authorization?.displayName ??
    existing?.displayName ??
    formatAuthorizationDisplayName(event.data.name);

  return {
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
    reason: event.data.reason,
    state: "completed",
    stepIndex: existing?.stepIndex ?? event.data.stepIndex,
    turnId: existing?.turnId ?? event.data.turnId,
    type: "authorization",
  };
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
