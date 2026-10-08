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
 * `step.started` falls between the request's `input.requested` and its
 * `input.resolved` (or the end of the stream, while it is still open).
 */
export function expectNoModelCallWhileOpen(on: EveEvalAssertions, requestId: string) {
  on.eventsSatisfy(`no model step starts while ${requestId} is open`, (events) => {
    const asked = events.findIndex(
      (event) =>
        event.type === "input.requested" &&
        event.data.requests.some((request) => request.requestId === requestId),
    );
    if (asked < 0) return false;
    const resolved = events.findIndex(
      (event, index) =>
        index > asked &&
        event.type === "input.resolved" &&
        event.data.resolutions.some((resolution) => resolution.requestId === requestId),
    );
    const open = events.slice(asked + 1, resolved < 0 ? events.length : resolved);
    return !open.some((event) => event.type === "step.started");
  });
}

/**
 * No `step.started` falls between the authorization `attemptId` opening and closing.
 * `before` carries the events streamed before `on` started, such as the ask.
 */
export function expectNoModelCallDuringAuthorization(
  on: EveEvalAssertions,
  attemptId: string,
  before: EveEvalTurn["events"] = [],
) {
  on.eventsSatisfy(`no model step starts while authorization ${attemptId} is open`, (observed) => {
    const events = [...before, ...observed];
    const asked = events.findIndex(
      (event) => event.type === "authorization.required" && event.data.attemptId === attemptId,
    );
    if (asked < 0) return false;
    const closed = events.findIndex(
      (event, index) =>
        index > asked &&
        event.type === "authorization.completed" &&
        event.data.attemptId === attemptId,
    );
    const open = events.slice(asked + 1, closed < 0 ? events.length : closed);
    return !open.some((event) => event.type === "step.started");
  });
}

/** The latest authorization `turn` asked for: its attempt and its fixture callback URL. */
export function authorizationFrom(turn: Pick<EveEvalTurn, "events">): {
  attemptId: string;
  url: URL;
} {
  const required = [...turn.events]
    .reverse()
    .find((event) => event.type === "authorization.required");
  if (
    required?.type !== "authorization.required" ||
    required.data.attemptId === undefined ||
    required.data.authorization?.url === undefined
  ) {
    throw new Error("Expected an authorization with an attempt id and a callback URL.");
  }
  return { attemptId: required.data.attemptId, url: new URL(required.data.authorization.url) };
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

/** The turn is held on input: it says so, and neither completes nor fails. */
export function expectHeld(turn: EveEvalTurn) {
  turn.event("turn.waiting", { data: { on: "input" } });
  turn.notEvent("turn.completed");
  turn.notEvent("turn.failed");
}

/** `request` resolved exactly once in `on`, with `outcome`. */
export function expectResolved(on: EveEvalAssertions, request: InputRequest, outcome: string) {
  on.event("input.resolved", {
    count: 1,
    data: {
      resolutions: (items) =>
        items.some((item) => item.requestId === request.requestId && item.outcome === outcome),
    },
  });
}

/** `toolName`'s call never ran: it has a rejected not-run result and no completed one. */
export function expectNotRun(on: EveEvalAssertions, toolName: string) {
  on.event("action.result", {
    data: { status: "rejected", result: { toolName } },
  });
  on.notEvent("action.result", { data: { status: "completed", result: { toolName } } });
}
