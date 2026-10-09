// Public interaction facts from the runtime's private request records. They describe what a
// person is asked and what decides it; actions, credentials and routing remain private.

import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { InputRequest } from "#shared/input.js";
import type { Scope } from "#protocol/session-events/envelope.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import type {
  InteractionOpenedData,
  InteractionRequest,
  InteractionSubject,
  SignInChallenge,
} from "#protocol/session-events/families/interaction.js";

/** A question, approval, or budget request, with its public subject explicit. */
export function interactionOpened(
  request: InputRequest,
  input: {
    readonly turnId: string;
    readonly taskId?: string;
    readonly callId?: string;
    readonly origin?: InteractionOpenedData["origin"];
    readonly audience?: InteractionOpenedData["audience"];
  },
): FactOf<"interaction.opened"> {
  const kind =
    request.kind === "tool-approval"
      ? "approval"
      : request.kind === "session-limit"
        ? "budget"
        : "question";
  const fields: { -readonly [K in keyof InteractionRequest]: InteractionRequest[K] } = {
    kind,
    prompt: request.prompt,
  };
  if (request.display !== undefined) fields.display = request.display;
  if (request.allowFreeform !== undefined) fields.allowFreeform = request.allowFreeform;
  if (request.options !== undefined) fields.options = request.options;
  const subject: InteractionSubject =
    kind === "budget"
      ? { turnId: input.turnId }
      : input.taskId !== undefined
        ? { taskId: input.taskId }
        : { callId: input.callId ?? request.action.callId };
  const data: { -readonly [K in keyof InteractionOpenedData]: InteractionOpenedData[K] } = {
    interactionId: request.requestId,
    request: fields,
    subject,
  };
  if (input.origin !== undefined) data.origin = input.origin;
  if (input.audience !== undefined) data.audience = input.audience;
  const scope: { -readonly [K in keyof Scope]: Scope[K] } = { turnId: input.turnId };
  if (input.taskId !== undefined) scope.taskId = input.taskId;
  return { type: "interaction.opened", data, scope };
}

/** A sign-in's public challenge. Provider callback payloads and credential resolvers stay off wire. */
export function signInOpened(
  challenge: AuthorizationChallenge,
  input: { readonly subject: InteractionSubject; readonly scope?: Scope },
): FactOf<"interaction.opened"> {
  const visible: { -readonly [K in keyof SignInChallenge]: SignInChallenge[K] } = {
    name: challenge.name,
  };
  const details = challenge.challenge;
  if (details.displayName !== undefined) visible.displayName = details.displayName;
  if (details.url !== undefined) visible.url = details.url;
  if (details.userCode !== undefined) visible.userCode = details.userCode;
  if (details.expiresAt !== undefined) visible.expiresAt = details.expiresAt;
  if (details.instructions !== undefined) visible.instructions = details.instructions;
  if (challenge.hookUrl !== undefined) visible.callbackUrl = challenge.hookUrl;
  const request: InteractionRequest = {
    kind: "sign-in",
    prompt: details.instructions ?? `Authorization required for ${challenge.name}`,
    signIn: visible,
  };
  const data: { -readonly [K in keyof InteractionOpenedData]: InteractionOpenedData[K] } = {
    interactionId: challenge.attemptId ?? challenge.name,
    request,
    subject: input.subject,
  };
  if (challenge.principalId !== undefined)
    data.audience = { principalIds: [challenge.principalId] };
  return { type: "interaction.opened", data, scope: input.scope };
}
