// Public interaction and response facts from the runtime's private request records. They say
// what a person is asked and what decided it; call actions, credentials, and answer routes stay
// private.

import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { Cause, Scope } from "#protocol/session-events/envelope.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import type {
  InteractionOpenedData,
  InteractionOutcome,
  InteractionRequest,
  InteractionSubject,
  SignInChallenge,
} from "#protocol/session-events/families/interaction.js";
import type {
  ResponseOutcome,
  ResponseSubmittedData,
} from "#protocol/session-events/families/response.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The public kind of a request: what renders it, not what produced it. */
export function interactionKind(
  request: Pick<InputRequest, "kind">,
): "approval" | "budget" | "question" {
  if (request.kind === "tool-approval") return "approval";
  if (request.kind === "session-limit") return "budget";
  return "question";
}

/** What a person is asked, without the call's action, which the subject's call row carries. */
export function interactionRequestOf(request: InputRequest): InteractionRequest {
  const fields: Mutable<InteractionRequest> = {
    kind: interactionKind(request),
    prompt: request.prompt,
  };
  if (request.display !== undefined) fields.display = request.display;
  if (request.allowFreeform !== undefined) fields.allowFreeform = request.allowFreeform;
  if (request.options !== undefined) fields.options = request.options;
  return fields;
}

/**
 * A question, approval, or budget prompt opens. An approval is about its call, a budget prompt
 * about its turn; a relayed request names the serving call or task it arrived through.
 */
export function interactionOpened(
  request: InputRequest,
  input: {
    readonly scope: Scope;
    readonly subject?: InteractionSubject;
    readonly origin?: InteractionOpenedData["origin"];
    readonly audience?: InteractionOpenedData["audience"];
  },
): FactOf<"interaction.opened"> {
  const kind = interactionKind(request);
  const subject: InteractionSubject =
    input.subject ??
    (kind === "budget" && input.scope.turnId !== undefined
      ? { turnId: input.scope.turnId }
      : { callId: request.action.callId });
  const data: Mutable<InteractionOpenedData> = {
    interactionId: request.requestId,
    request: interactionRequestOf(request),
    subject,
  };
  if (input.origin !== undefined) data.origin = input.origin;
  if (input.audience !== undefined) data.audience = input.audience;
  return { type: "interaction.opened", data, scope: input.scope };
}

/** The interaction a sign-in attempt is: its attempt id, or its connection name without one. */
export function signInInteractionId(
  challenge: Pick<AuthorizationChallenge, "attemptId" | "name">,
): string {
  return challenge.attemptId ?? challenge.name;
}

/** A sign-in's public challenge. Provider callback payloads and credential resolvers stay private. */
export function signInOpened(
  challenge: AuthorizationChallenge,
  input: {
    readonly subject: InteractionSubject;
    readonly scope: Scope;
    readonly origin?: InteractionOpenedData["origin"];
    readonly prompt?: string;
  },
): FactOf<"interaction.opened"> {
  const visible: Mutable<SignInChallenge> = { name: challenge.name };
  const details = challenge.challenge;
  if (details.displayName !== undefined) visible.displayName = details.displayName;
  if (details.url !== undefined) visible.url = details.url;
  if (details.userCode !== undefined) visible.userCode = details.userCode;
  if (details.expiresAt !== undefined) visible.expiresAt = details.expiresAt;
  if (details.instructions !== undefined) visible.instructions = details.instructions;
  if (challenge.hookUrl !== undefined) visible.callbackUrl = challenge.hookUrl;
  const request: Mutable<InteractionRequest> = {
    kind: "sign-in",
    prompt: input.prompt ?? details.instructions ?? `Authorization required for ${challenge.name}`,
    signIn: visible,
  };
  if (details.url !== undefined) request.link = { url: details.url };
  const data: Mutable<InteractionOpenedData> = {
    interactionId: signInInteractionId(challenge),
    request,
    subject: input.subject,
  };
  if (challenge.principalId !== undefined)
    data.audience = { principalIds: [challenge.principalId] };
  if (input.origin !== undefined) data.origin = input.origin;
  return { type: "interaction.opened", data, scope: input.scope };
}

/** An interaction ends. `cause` names the response that decided it, or what else settled it. */
export function interactionSettled(
  interactionId: string,
  outcome: InteractionOutcome,
  input: {
    readonly scope?: Scope;
    readonly reason?: string;
    readonly cause?: Cause;
    readonly response?: InputResponse;
  } = {},
): FactOf<"interaction.settled"> {
  const data: Mutable<FactOf<"interaction.settled">["data"]> = { interactionId, outcome };
  if (input.reason !== undefined) data.reason = input.reason;
  if (input.cause !== undefined) data.cause = input.cause;
  if (input.response !== undefined) {
    const detail: { optionId?: string; text?: string } = {};
    if (input.response.optionId !== undefined) detail.optionId = input.response.optionId;
    if (input.response.text !== undefined) detail.text = input.response.text;
    if (Object.keys(detail).length > 0) data.response = detail;
  }
  return input.scope === undefined || Object.keys(input.scope).length === 0
    ? { type: "interaction.settled", data }
    : { type: "interaction.settled", data, scope: input.scope };
}

export function responseSubmitted(binding: ResponseSubmittedData): FactOf<"response.submitted"> {
  const data: Mutable<ResponseSubmittedData> = {
    deliveryId: binding.deliveryId,
    interactionId: binding.interactionId,
    responseId: binding.responseId,
  };
  if (binding.value !== undefined && Object.keys(binding.value).length > 0)
    data.value = binding.value;
  return { type: "response.submitted", data };
}

export function responseAdmitted(responseId: string): FactOf<"response.admitted"> {
  return { type: "response.admitted", data: { responseId } };
}

export function responseSettled(
  responseId: string,
  outcome: ResponseOutcome,
  reason?: string,
): FactOf<"response.settled"> {
  return reason === undefined
    ? { type: "response.settled", data: { outcome, responseId } }
    : { type: "response.settled", data: { outcome, reason, responseId } };
}
