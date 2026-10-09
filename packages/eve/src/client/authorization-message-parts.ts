import type { SignInPrompt, SignInSettlement } from "#channel/interaction-prompts.js";
import type { EveAuthorizationPart } from "#client/message-reducer-types.js";

type MutableAuthorizationPart<T extends EveAuthorizationPart> = {
  -readonly [K in keyof T]: T[K];
};

export function createAuthorizationRequiredPart(
  prompt: SignInPrompt,
  place: { readonly turnId: string; readonly stepIndex: number },
): EveAuthorizationPart {
  const displayName =
    prompt.authorization?.displayName ?? formatAuthorizationDisplayName(prompt.name);

  const part: MutableAuthorizationPart<Extract<EveAuthorizationPart, { state: "required" }>> = {
    authorization: prompt.authorization,
    description: normalizeAuthorizationDescription(prompt.description, prompt.name, displayName),
    displayName,
    name: prompt.name,
    state: "required",
    stepIndex: place.stepIndex,
    turnId: place.turnId,
    type: "authorization",
  };
  part.attemptId = prompt.attemptId;
  if (prompt.webhookUrl !== undefined) part.awaitsCallback = true;
  return part;
}

export function createAuthorizationCompletedPart(
  settled: SignInSettlement,
  place: { readonly turnId: string; readonly stepIndex: number },
  existing?: EveAuthorizationPart,
): EveAuthorizationPart {
  const displayName =
    settled.authorization?.displayName ??
    existing?.displayName ??
    formatAuthorizationDisplayName(settled.name);

  const part: MutableAuthorizationPart<Extract<EveAuthorizationPart, { state: "completed" }>> = {
    authorization:
      existing?.authorization || settled.authorization
        ? { ...existing?.authorization, ...settled.authorization }
        : undefined,
    description:
      existing?.description ??
      buildCompletedAuthorizationDescription(displayName, settled.outcome, settled.reason),
    displayName,
    name: settled.name,
    outcome: settled.outcome,
    state: "completed",
    stepIndex: existing?.stepIndex ?? place.stepIndex,
    turnId: existing?.turnId ?? place.turnId,
    type: "authorization",
  };
  part.attemptId = settled.attemptId;
  if (existing?.awaitsCallback) part.awaitsCallback = true;
  if (settled.reason !== undefined) part.reason = settled.reason;
  return part;
}

function buildCompletedAuthorizationDescription(
  displayName: string,
  outcome: SignInSettlement["outcome"],
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
