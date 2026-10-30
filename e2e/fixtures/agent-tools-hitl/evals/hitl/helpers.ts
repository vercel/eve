import type { Interaction, InteractionOutcome } from "eve/events";
import type { EveEvalAssertions, EveEvalContext, EveEvalSession, EveEvalTurn } from "eve/evals";

import { SAY } from "../../agent/lib/hitl/respond.ts";

export { REPLY, SAY } from "../../agent/lib/hitl/respond.ts";

export const ALICE = "alice";
export const BOB = "bob";
/** The fixture's authorized approver for `authorized-change` and `responder-gate`. */
export const RELEASE_MANAGER = "e2e-approval-responder";

/** Headers for one person on the scripted hitl model; `flag` feeds fixture policies. */
export function as(principalId: string, flag?: "retire" | "freeze") {
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
export function approvalFor(turn: EveEvalTurn, toolName: string): Interaction {
  const matches = turn.interactions.filter(
    (request) => (request.call?.name ?? request.request.kind) === toolName,
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one ${toolName} request; found ${matches.length}.`);
  }
  return matches[0]!;
}

/** `respond` answers for the given requests, all with one option. */
export function answers(optionId: string, ...requests: readonly Interaction[]) {
  return requests.map(({ interactionId }) => ({ optionId, interactionId }));
}

/**
 * The model never runs while a request of the turn's own is open: no
 * `model.started` falls between the request's `interaction.opened` and its
 * `interaction.settled` (or the end of the stream, while it is still open).
 */
export function expectNoModelCallWhileOpen(on: EveEvalAssertions, interactionId: string) {
  on.eventsSatisfy(`no model run starts while ${interactionId} is open`, (events) =>
    noModelCallBetween(events, interactionId),
  );
}

/**
 * The model says nothing between the sign-in `attemptId` opening and settling. A model run may
 * start in that window: its step runs the call the sign-in was for, and the sign-in settles with
 * that call, before the run's provider call.
 * `before` carries the events streamed before `on` started, such as the ask.
 */
export function expectNoModelCallDuringAuthorization(
  on: EveEvalAssertions,
  attemptId: string,
  before: EveEvalTurn["events"] = [],
) {
  on.eventsSatisfy(`the model says nothing while sign-in ${attemptId} is open`, (observed) => {
    const events = [...before, ...observed];
    const open = eventsWhileOpen(events, attemptId);
    return open !== undefined && !open.some((event) => MODEL_OUTPUT_EVENTS.has(event.type));
  });
}

/** What the model streams: content, and the calls it makes. */
const MODEL_OUTPUT_EVENTS = new Set<string>([
  "call.input",
  "call.requested",
  "content.completed",
  "content.delta",
  "model.settled",
]);

/** Whether no model run starts while the interaction `interactionId` is open in `events`. */
function noModelCallBetween(events: EveEvalTurn["events"], interactionId: string): boolean {
  const open = eventsWhileOpen(events, interactionId);
  return open !== undefined && !open.some((event) => event.type === "model.started");
}

/**
 * The events between the interaction `interactionId` opening and settling (or the end of the
 * stream, while it is still open); `undefined` when it never opened.
 */
function eventsWhileOpen(
  events: EveEvalTurn["events"],
  interactionId: string,
): EveEvalTurn["events"] | undefined {
  const asked = events.findIndex(
    (event) => event.type === "interaction.opened" && event.data.interactionId === interactionId,
  );
  if (asked < 0) return undefined;
  const settled = events.findIndex(
    (event, index) =>
      index > asked &&
      event.type === "interaction.settled" &&
      event.data.interactionId === interactionId,
  );
  return events.slice(asked + 1, settled < 0 ? events.length : settled);
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

/** Completes a fixture authorization the way a browser would: a GET on the callback URL. */
export async function completeAuthorization(t: EveEvalContext, url: URL) {
  const callback = await t.target.fetch(`${url.pathname}${url.search}`);
  if (!callback.ok) throw new Error(`Fixture authorization callback failed (${callback.status}).`);
}

/** Everything the session streams from `startIndex` to the next turn boundary. */
export function follow(t: EveEvalContext, session: EveEvalSession, startIndex: number) {
  return t.target.attach(session.id, { startIndex }).watch().result();
}

/**
 * Alice spends the session's output budget on a summary, then asks for a
 * status note: the turn stops before its model call and asks whether to go on.
 */
export async function budgetQuestion(t: EveEvalContext) {
  const session = await aliceSession(t);
  (await session.send(SAY.spendBudget, asAlice)).expectOk();
  const held = await session.send(SAY.statusNote, asAlice);
  const request = approvalFor(held, "budget");
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
  request: Interaction,
  outcome: InteractionOutcome,
) {
  on.event("interaction.settled", {
    count: 1,
    data: { interactionId: request.interactionId, outcome },
  });
}

/** `toolName`'s call never ran: it settled rejected, and no call of it completed. */
export function expectNotRun(on: EveEvalAssertions, toolName: string) {
  on.calledTool(toolName, { status: "rejected" });
  on.calledTool(toolName, { count: 0, status: "completed" });
}
