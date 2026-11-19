import type {
  InteractionOutcome,
  InteractionRequest,
  SignInChallenge,
} from "#protocol/session-events/families/interaction.js";
import type { Answer } from "#protocol/session-events/families/response.js";
import type { JsonValue, Principal } from "#protocol/session-events/envelope.js";
import {
  answeredInteractionIds,
  callRun,
  callTurn,
  interactionOwner,
  openInteractions,
} from "#protocol/session-projection/selectors.js";
import type { InteractionRow, SessionView } from "#protocol/session-projection/tables.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface RunPlace {
  readonly turnId: string;
  readonly stepIndex: number;
}

export function runPlace(view: SessionView, runId: string | undefined): RunPlace | undefined {
  const row = runId === undefined ? undefined : view.runs[runId];
  if (row === undefined || row.step === undefined || !("turnId" in row.owner)) return undefined;
  return { stepIndex: row.step, turnId: row.owner.turnId };
}

export function partPlace(
  view: SessionView,
  row: { readonly runId?: string; readonly turnId?: string; readonly introducedAt?: number },
): RunPlace | undefined {
  if (row.runId !== undefined) return runPlace(view, row.runId);
  return row.turnId === undefined
    ? undefined
    : { stepIndex: turnStepAt(view, row.turnId, row.introducedAt), turnId: row.turnId };
}

export function turnStepAt(view: SessionView, turnId: string, position = Infinity): number {
  let step = 0;
  for (const row of Object.values(view.runs)) {
    if (row.step === undefined || row.introducedAt > position) continue;
    if ("turnId" in row.owner && row.owner.turnId === turnId) step = Math.max(step, row.step);
  }
  return step;
}

export function callPlace(view: SessionView, callId: string): RunPlace | undefined {
  const row = view.calls[callId];
  if (row === undefined) return undefined;
  const place = runPlace(view, callRun(view, row));
  if (place !== undefined) return place;
  const turnId = callTurn(view, row) ?? view.session.latestTurnId;
  return turnId === undefined
    ? undefined
    : { stepIndex: turnStepAt(view, turnId, row.introducedAt), turnId };
}

export const SUPERSEDED_BY_MESSAGE = "superseded-by-message";

/** The call an interaction asks about. */
export interface AskedCall {
  readonly callId: string;
  readonly name: string;
  readonly input?: JsonValue;
}

export function askedCall(view: SessionView, row: InteractionRow): AskedCall | undefined {
  if (row.origin !== undefined) return row.origin.call;
  if (!("callId" in row.subject)) return undefined;
  const call = view.calls[row.subject.callId];
  if (call === undefined) return undefined;
  return call.input === undefined
    ? { callId: call.callId, name: call.capability.name }
    : { callId: call.callId, input: call.input, name: call.capability.name };
}

type InteractionPlace = Pick<Interaction, "turnId" | "stepIndex" | "taskId">;

export function interactionPlace(view: SessionView, row: InteractionRow): InteractionPlace {
  const owner = interactionOwner(view, row);
  const turnId = owner.turnId ?? view.session.latestTurnId ?? "turn_0";
  const place: Mutable<InteractionPlace> = {
    stepIndex: turnStepAt(view, turnId, row.introducedAt),
    turnId,
  };
  const taskId = owner.taskId ?? ("taskId" in row.subject ? row.subject.taskId : undefined);
  if (taskId !== undefined) place.taskId = taskId;
  return place;
}

/** An interaction as a conversation reader shows it: what it asks, where, and how it stands. */
export interface Interaction {
  readonly interactionId: string;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly taskId?: string;
  readonly request: Omit<InteractionRequest, "signIn"> & {
    readonly signIn?: Omit<SignInChallenge, "callbackUrl">;
  };
  readonly call?: AskedCall;
  readonly status: "open" | "settled";
  readonly outcome?: InteractionOutcome;
  readonly reason?: string;
  /** The deciding answer once settled; while open, the latest unsettled submitted answer. */
  readonly answer?: Answer;
}

export function interaction(view: SessionView, interactionId: string): Interaction | undefined {
  const row = view.interactions[interactionId];
  if (row === undefined) return undefined;
  let request: Interaction["request"] = row.request;
  if (row.request.signIn !== undefined) {
    const { callbackUrl: _callbackUrl, ...signIn } = row.request.signIn;
    request = { ...row.request, signIn };
  }
  const shown: Mutable<Interaction> = {
    ...interactionPlace(view, row),
    interactionId,
    request,
    status: row.status,
  };
  const call = askedCall(view, row);
  if (call !== undefined) shown.call = call;
  if (row.outcome !== undefined) shown.outcome = row.outcome;
  if (row.reason !== undefined) shown.reason = row.reason;
  let answer = decidingAnswer(row);
  if (row.status === "open") {
    for (const response of Object.values(view.responses)) {
      if (response.interactionId !== interactionId || response.status === "settled") continue;
      if (response.value !== undefined) answer = { ...response.value, interactionId };
    }
  }
  if (answer !== undefined) shown.answer = answer;
  return shown;
}

export function decidingAnswer(row: InteractionRow): Answer | undefined {
  const value = row.response;
  if (value === undefined) return undefined;
  const answer: { interactionId: string; optionId?: string; text?: string } = {
    interactionId: row.interactionId,
  };
  if (typeof value.optionId === "string") answer.optionId = value.optionId;
  if (typeof value.text === "string") answer.text = value.text;
  return answer.optionId === undefined && answer.text === undefined ? undefined : answer;
}

export function responderOf(view: SessionView, responseId: string): Principal | undefined {
  const response = view.responses[responseId];
  return response === undefined ? undefined : view.deliveries[response.deliveryId]?.principal;
}

export function openRequests(view: SessionView | undefined): readonly InteractionRow[] {
  if (view === undefined) return [];
  return openInteractions(view).filter((row) => row.request.kind !== "sign-in");
}

export function openSignIns(view: SessionView | undefined): readonly InteractionRow[] {
  return view === undefined ? [] : openInteractions(view, { kind: "sign-in" });
}

/** How a sign-in's end reads to a person: connected, or why it didn't. */
export function signInEnding(
  outcome: InteractionOutcome,
): "connected" | "declined" | "failed" | "timed out" | "cancelled" {
  switch (outcome) {
    case "accepted":
      return "connected";
    case "declined":
    case "invalid":
      return "declined";
    case "failed":
      return "failed";
    case "expired":
      return "timed out";
    default:
      return "cancelled";
  }
}

export function promptQueueHead(
  view: SessionView,
  answered: (interactionId: string) => boolean = () => false,
): InteractionRow | undefined {
  const admitted = answeredInteractionIds(view);
  const open = openRequests(view).filter(
    (row) => !answered(row.interactionId) && !admitted.has(row.interactionId),
  );
  return open.find((row) => row.request.kind === "budget") ?? open[0];
}
