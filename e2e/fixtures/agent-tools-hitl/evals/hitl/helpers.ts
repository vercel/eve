import type { InteractionOutcome } from "eve/client";
import type {
  EveEvalAssertions,
  EveEvalContext,
  EveEvalSession,
  EveEvalTurn,
  InputRequest,
} from "eve/evals";

import { SAY } from "../../agent/lib/hitl/respond.ts";

export { REPLY, SAY } from "../../agent/lib/hitl/respond.ts";

export const ALICE = "alice";
export const BOB = "bob";
/** The fixture's authorized approver for `authorized-change` and `responder-gate`. */
export const RELEASE_MANAGER = "e2e-approval-responder";

/** Headers for one person on the scripted hitl model; `flag` feeds fixture policies. */
export function as(principalId: string, flag?: "retire") {
  return {
    headers: {
      "x-eve-fixture-model": "hitl",
      "x-eve-fixture-user": principalId,
      ...(flag !== undefined && { "x-eve-fixture-flag": flag }),
    },
  };
}

/**
 * A session Alice starts, so the scripted model drives every turn of it.
 * Headers apply per request: pass `as(...)` to every send and respond too.
 */
export function aliceSession(t: EveEvalContext): Promise<EveEvalSession> {
  return t.session(as(ALICE));
}

export const asAlice = as(ALICE);
export const asBob = as(BOB);
export const asReleaseManager = as(RELEASE_MANAGER);

/** The one approval request `turn` raised for `toolName`. */
export function approvalFor(turn: EveEvalTurn, toolName: string): InputRequest {
  const matches = turn.inputRequests.filter((request) => request.action.toolName === toolName);
  if (matches.length !== 1) {
    throw new Error(`Expected one ${toolName} request; found ${matches.length}.`);
  }
  return matches[0]!;
}

/** `respond` answers for the given requests, all with one option. */
export function answers(optionId: string, ...requests: readonly InputRequest[]) {
  return requests.map(({ requestId }) => ({ optionId, requestId }));
}

/**
 * The model never runs while a request of the turn's own is open: no
 * `model.started` falls between the request's `interaction.opened` and its
 * `interaction.settled` (or the end of the stream, while it is still open).
 */
export function expectNoModelCallWhileOpen(on: EveEvalAssertions, requestId: string) {
  on.eventsSatisfy(`no model run starts while ${requestId} is open`, (events) =>
    noModelCallBetween(events, requestId),
  );
}

/**
 * No `model.started` falls between the sign-in `attemptId` opening and settling.
 * `before` carries the events streamed before `on` started, such as the ask.
 */
export function expectNoModelCallDuringAuthorization(
  on: EveEvalAssertions,
  attemptId: string,
  before: EveEvalTurn["events"] = [],
) {
  on.eventsSatisfy(`no model run starts while sign-in ${attemptId} is open`, (observed) =>
    noModelCallBetween([...before, ...observed], attemptId),
  );
}

/** Whether no model run starts while the interaction `interactionId` is open in `events`. */
function noModelCallBetween(events: EveEvalTurn["events"], interactionId: string): boolean {
  const asked = events.findIndex(
    (event) => event.type === "interaction.opened" && event.data.interactionId === interactionId,
  );
  if (asked < 0) return false;
  const settled = events.findIndex(
    (event, index) =>
      index > asked &&
      event.type === "interaction.settled" &&
      event.data.interactionId === interactionId,
  );
  const open = events.slice(asked + 1, settled < 0 ? events.length : settled);
  return !open.some((event) => event.type === "model.started");
}

/** The latest sign-in `turn` asked for: its interaction and its fixture callback URL. */
export function authorizationFrom(turn: Pick<EveEvalTurn, "events">): {
  attemptId: string;
  url: URL;
} {
  const required = [...turn.events]
    .reverse()
    .find((event) => event.type === "interaction.opened" && event.data.request.kind === "sign-in");
  const url =
    required?.type === "interaction.opened" ? required.data.request.signIn?.url : undefined;
  if (required?.type !== "interaction.opened" || url === undefined) {
    throw new Error("Expected a sign-in with a callback URL.");
  }
  return { attemptId: required.data.interactionId, url: new URL(url) };
}

/** Completes a fixture authorization the way a browser would: an unauthenticated GET. */
export async function completeAuthorization(url: URL) {
  const callback = await fetch(url);
  if (!callback.ok) throw new Error(`Fixture authorization callback failed (${callback.status}).`);
}

/** Everything the session streams from `startIndex` to the next turn boundary. */
export function follow(t: EveEvalContext, session: EveEvalSession, startIndex: number) {
  return t.target.watchTurn(session.sessionId, { startIndex }).result();
}

/**
 * Alice spends the session's output budget on a summary, then asks for a
 * status note: the turn stops before its model call and asks whether to go on.
 */
export async function budgetQuestion(t: EveEvalContext) {
  const session = await aliceSession(t);
  (await session.send(SAY.spendBudget, asAlice)).expectOk();
  const held = await session.send(SAY.statusNote, asAlice);
  const request = approvalFor(held, "session_limit_continuation");
  return { held, request, session };
}

/** The turn is held on a person: it pauses for an interaction, and doesn't settle. */
export function expectHeld(turn: EveEvalTurn) {
  turn.event("turn.paused", {
    data: { awaiting: (awaiting) => awaiting.some((entry) => "interactionId" in entry) },
  });
  turn.notEvent("turn.settled");
}

/** `request` settled exactly once in `on`, with `outcome`. */
export function expectResolved(
  on: EveEvalAssertions,
  request: InputRequest,
  outcome: InteractionOutcome,
) {
  on.event("interaction.settled", {
    count: 1,
    data: { interactionId: request.requestId, outcome },
  });
}

/** `toolName`'s call never ran: it settled rejected, and no call of it completed. */
export function expectNotRun(on: EveEvalAssertions, toolName: string) {
  on.calledTool(toolName, { status: "rejected" });
  on.calledTool(toolName, { count: 0, status: "completed" });
}
