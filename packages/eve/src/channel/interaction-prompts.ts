// What channels render about interactions, read from the facts and the line's tables: the batch of
// requests a commit opened, a sign-in prompt, how a request or sign-in settled, and a responder an
// approval refused. Built-in channels render these; authored handlers can read the facts directly.

import type { AuthorizationOutcome, InputResolution } from "#protocol/message.js";
import type { Principal, Scope } from "#protocol/session-events/envelope.js";
import type {
  InteractionOpenedData,
  InteractionOutcome,
  InteractionSettledData,
} from "#protocol/session-events/families/interaction.js";
import type { ResponseSettledData } from "#protocol/session-events/families/response.js";
import {
  answeredInteractionIds,
  interactionOwner,
} from "#protocol/session-projection/selectors.js";
import type { InteractionRow, SessionView } from "#protocol/session-projection/tables.js";
import { readerInput } from "#protocol/session-reader.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * A request as the session that serves this one reads it: with the call it's about, or, for a
 * request this session relays, the asker's call its origin names.
 */
export function inputRequestOf(view: SessionView, row: InteractionRow): InputRequest | undefined {
  return readerInput(view, row.interactionId)?.request;
}

/** One commit's requests: what a person is asked at once. */
export interface RequestBatch {
  readonly requests: readonly InputRequest[];
  readonly turnId: string;
  /** The task whose run asks. */
  readonly taskId?: string;
  /** The call a relayed request serves. */
  readonly callId?: string;
}

/** What a sign-in asks of a person, and where to complete it. */
export interface SignInPrompt {
  readonly attemptId: string;
  readonly name: string;
  readonly description: string;
  readonly authorization?: {
    readonly url?: string;
    readonly userCode?: string;
    readonly expiresAt?: string;
    readonly instructions?: string;
    readonly displayName?: string;
  };
  readonly webhookUrl?: string;
  /** Who the sign-in is for: the principal that started it. */
  readonly principalId?: string;
  /** The approval response whose responder signs in. */
  readonly responseId?: string;
  readonly taskId?: string;
  readonly turnId?: string;
}

/** How a sign-in ended. */
export interface SignInSettlement {
  readonly attemptId: string;
  readonly name: string;
  readonly outcome: AuthorizationOutcome;
  readonly reason?: string;
  readonly principalId?: string;
  readonly responseId?: string;
  readonly authorization?: SignInPrompt["authorization"];
  readonly taskId?: string;
}

/** How a request ended, with the answer that decided it and who gave it. */
export interface RequestSettlement extends InputResolution {
  /** Who gave the deciding answer, through its delivery. */
  readonly responder?: Principal;
  readonly reason?: string;
}

/** An answer a check or policy refused, for telling its responder privately. */
export interface RefusedAnswer {
  readonly interactionId: string;
  readonly outcome: "refused" | "failed";
  readonly reason?: string;
  readonly responder?: Principal;
}

/**
 * The batch an `interaction.opened` begins: every request its commit opened. The batch's other
 * facts return `undefined`, so a channel renders it once.
 */
export function requestBatchOf(
  view: SessionView,
  data: InteractionOpenedData,
): RequestBatch | undefined {
  const row = view.interactions[data.interactionId];
  if (row === undefined || row.request.kind === "sign-in") return undefined;
  const batch = Object.values(view.interactions).filter(
    (entry) => entry.introducedAt === row.introducedAt && entry.request.kind !== "sign-in",
  );
  if (batch[0]?.interactionId !== data.interactionId) return undefined;
  const requests = batch.flatMap((entry) => inputRequestOf(view, entry) ?? []);
  if (requests.length === 0) return undefined;
  const owner = interactionOwner(view, row);
  const result: Mutable<RequestBatch> = { requests, turnId: owner.turnId ?? "" };
  if (owner.taskId !== undefined) result.taskId = owner.taskId;
  if (row.origin !== undefined || row.request.kind === "question") {
    if ("callId" in row.subject) result.callId = row.subject.callId;
  }
  return result;
}

/**
 * The request a typed reply answers: the first open one. A budget prompt comes first, since the
 * session settles it before anything else; the rest follow the order they opened. Channels that
 * can only show text show this request alone, so a reply answers the request the person sees.
 */
export function firstOpenRequest(view: SessionView): InputRequest | undefined {
  // An answer that waits for the rest of its batch answered its request for now.
  const answered = answeredInteractionIds(view);
  const open = Object.values(view.interactions)
    .filter(
      (row) =>
        row.status === "open" && row.request.kind !== "sign-in" && !answered.has(row.interactionId),
    )
    .sort((a, b) => a.introducedAt - b.introducedAt);
  const first = open.find((row) => row.request.kind === "budget") ?? open[0];
  return first === undefined ? undefined : inputRequestOf(view, first);
}

/** A sign-in's prompt, from its `interaction.opened`. */
export function signInPromptOf(
  data: InteractionOpenedData,
  scope?: Scope,
): SignInPrompt | undefined {
  const { request, subject } = data;
  if (request.kind !== "sign-in") return undefined;
  const signIn = request.signIn;
  const prompt: Mutable<SignInPrompt> = {
    attemptId: data.interactionId,
    description: request.prompt,
    name: signIn?.name ?? data.interactionId,
  };
  const authorization = challengeOf(signIn);
  if (authorization !== undefined && signIn?.callbackUrl !== undefined) {
    prompt.authorization = authorization;
    prompt.webhookUrl = signIn.callbackUrl;
  }
  const principalId = data.audience?.principalIds[0];
  if (principalId !== undefined) prompt.principalId = principalId;
  if ("responseId" in subject) prompt.responseId = subject.responseId;
  const taskId = scope?.taskId ?? ("taskId" in subject ? subject.taskId : undefined);
  if (taskId !== undefined) prompt.taskId = taskId;
  const turnId = scope?.turnId ?? ("turnId" in subject ? subject.turnId : undefined);
  if (turnId !== undefined) prompt.turnId = turnId;
  return prompt;
}

/** How a sign-in ended, from its `interaction.settled`. */
export function signInSettlementOf(
  view: SessionView,
  data: InteractionSettledData,
): SignInSettlement | undefined {
  const row = view.interactions[data.interactionId];
  if (row === undefined || row.request.kind !== "sign-in") return undefined;
  const signIn = row.request.signIn;
  const settled: Mutable<SignInSettlement> = {
    attemptId: row.interactionId,
    name: signIn?.name ?? row.interactionId,
    outcome: signInOutcomeOf(data.outcome),
  };
  if (data.reason !== undefined) settled.reason = data.reason;
  const principalId = row.audience?.principalIds[0];
  if (principalId !== undefined) settled.principalId = principalId;
  if ("responseId" in row.subject) settled.responseId = row.subject.responseId;
  const authorization = challengeOf(signIn);
  if (authorization !== undefined) settled.authorization = authorization;
  const taskId = interactionOwner(view, row).taskId;
  if (taskId !== undefined) settled.taskId = taskId;
  return settled;
}

/** How a request ended, from its `interaction.settled`. */
export function requestSettlementOf(
  view: SessionView,
  data: InteractionSettledData,
): RequestSettlement | undefined {
  const row = view.interactions[data.interactionId];
  if (row === undefined || row.request.kind === "sign-in") return undefined;
  const kind = requestKind(row);
  if (kind === undefined) return undefined;
  const settled: Mutable<RequestSettlement> = {
    kind,
    outcome: resolutionOutcome(kind, data.outcome, data.reason),
    requestId: row.interactionId,
  };
  const response = answerOf(row.interactionId, data.response);
  if (response !== undefined) settled.response = response;
  if (data.reason !== undefined) settled.reason = data.reason;
  const responder =
    data.cause !== undefined && "responseId" in data.cause
      ? responderOf(view, data.cause.responseId)
      : undefined;
  if (responder !== undefined) settled.responder = responder;
  return settled;
}

/** An answer a check or policy refused, from its `response.settled`. */
export function refusedAnswerOf(
  view: SessionView,
  data: ResponseSettledData,
): RefusedAnswer | undefined {
  if (data.outcome !== "refused" && data.outcome !== "failed") return undefined;
  const row = view.responses[data.responseId];
  if (row === undefined) return undefined;
  const refused: Mutable<RefusedAnswer> = {
    interactionId: row.interactionId,
    outcome: data.outcome,
  };
  if (data.reason !== undefined) refused.reason = data.reason;
  const responder = responderOf(view, data.responseId);
  if (responder !== undefined) refused.responder = responder;
  return refused;
}

/** Who gave an answer: the principal of the delivery it arrived in. */
export function responderOf(view: SessionView, responseId: string): Principal | undefined {
  const response = view.responses[responseId];
  return response === undefined ? undefined : view.deliveries[response.deliveryId]?.principal;
}

function requestKind(row: InteractionRow): InputRequest["kind"] | undefined {
  if (row.request.kind === "approval") return "tool-approval";
  if (row.request.kind === "budget") return "session-limit";
  if (row.request.kind === "question") return "question";
  return undefined;
}

function resolutionOutcome(
  kind: InputRequest["kind"],
  outcome: InteractionOutcome,
  reason: string | undefined,
): InputResolution["outcome"] {
  switch (outcome) {
    case "accepted":
      return kind === "tool-approval" ? "approved" : "answered";
    case "declined":
      return kind === "tool-approval" ? "denied" : "answered";
    case "invalid":
      return "invalid";
    case "withdrawn":
      return reason === "superseded-by-message" ? "ignored" : "cancelled";
    default:
      return "cancelled";
  }
}

/** How a sign-in's interaction outcome reads as an authorization outcome. */
export function signInOutcomeOf(outcome: InteractionOutcome): AuthorizationOutcome {
  if (outcome === "accepted") return "authorized";
  if (outcome === "expired") return "timed-out";
  if (outcome === "failed" || outcome === "abandoned") return "failed";
  return "declined";
}

function challengeOf(
  signIn: InteractionOpenedData["request"]["signIn"],
): SignInPrompt["authorization"] | undefined {
  if (signIn === undefined) return undefined;
  const challenge: Mutable<NonNullable<SignInPrompt["authorization"]>> = {};
  if (signIn.url !== undefined) challenge.url = signIn.url;
  if (signIn.userCode !== undefined) challenge.userCode = signIn.userCode;
  if (signIn.expiresAt !== undefined) challenge.expiresAt = signIn.expiresAt;
  if (signIn.instructions !== undefined) challenge.instructions = signIn.instructions;
  if (signIn.displayName !== undefined) challenge.displayName = signIn.displayName;
  return Object.keys(challenge).length === 0 ? undefined : challenge;
}

function answerOf(
  requestId: string,
  detail: { readonly [key: string]: unknown } | undefined,
): InputResponse | undefined {
  if (detail === undefined) return undefined;
  const answer: { requestId: string; optionId?: string; text?: string } = { requestId };
  if (typeof detail.optionId === "string") answer.optionId = detail.optionId;
  if (typeof detail.text === "string") answer.text = detail.text;
  return answer.optionId === undefined && answer.text === undefined ? undefined : answer;
}
