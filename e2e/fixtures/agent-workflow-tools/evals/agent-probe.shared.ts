import type { EveEvalContext, EveEvalSession, EveEvalStreamEvent, EveEvalTurn } from "eve/evals";

import { fixtureAuthorizationCallback } from "../agent/lib/fake-service.ts";

export type ProbeCase = { readonly kind: "auth" | "hitl" };

type SessionCursor = Pick<
  EveEvalSession,
  "pendingInputRequests" | "requireInputRequest" | "respondAll" | "sessionId" | "state"
>;

export async function runProbe(t: EveEvalContext, probe: ProbeCase): Promise<void> {
  const directive = `WORKFLOW-PROBE-blocking-local-${probe.kind}`;

  if (probe.kind === "hitl") {
    const started = await t.send(directive);
    started.expectOk();
    const blocked = await waitForInput(t, started.session, "approval-gate");
    const approved = await blocked.respondAll("approve");
    approved.expectOk();
    await waitForMarker(t, blocked, approved, "WORKFLOW-HITL:approved");
  } else {
    const { turn } = await completeSignIn(t, directive, (url) => {
      if (url === undefined) {
        throw new Error("Authorization probe produced no callback URL.");
      }
      return new URL(url);
    });
    requireAuthorizationOutcome(turn, "authorized");
    requireMarker(turn, "WORKFLOW-AUTH:authorized");
  }

  t.succeeded();
  t.noFailedActions();
}

async function waitForInput(
  t: EveEvalContext,
  initial: SessionCursor,
  toolName: string,
): Promise<SessionCursor> {
  let session = initial;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (session.pendingInputRequests.some((request) => request.action.toolName === toolName)) {
      session.requireInputRequest({ toolName });
      return session;
    }

    const live = watchNext(t, session);
    const turn = await live.result();
    turn.noFailedActions();
    session = live.session;
  }

  throw new Error(`Probe did not surface input for ${toolName}.`);
}

async function waitForMarker(
  t: EveEvalContext,
  initial: SessionCursor,
  initialTurn: EveEvalTurn | undefined,
  marker: string,
): Promise<EveEvalTurn> {
  if (initialTurn?.message?.includes(marker)) {
    return initialTurn;
  }

  let session = initial;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const live = watchNext(t, session);
    const turn = await live.result();
    turn.noFailedActions();
    if (turn.message?.includes(marker)) {
      return turn;
    }

    session = live.session;
  }

  throw new Error(`Probe did not produce ${marker}.`);
}

/**
 * A sign-in inside a running call holds the turn: the response stops at its
 * `turn.waiting` (`on: "input"`). Complete the sign-in, then read the same
 * turn to its end.
 */
async function completeSignIn(
  t: EveEvalContext,
  message: string,
  toCallbackUrl: (authorizationUrl: string | undefined) => URL,
): Promise<{ readonly callbackUrl: URL; readonly turn: EveEvalTurn }> {
  const session = await t.session();
  const live = await session.start(message);
  const held = await live.result();
  const required = held.events.find((event) => event.type === "authorization.required");
  if (required?.type !== "authorization.required") {
    throw new Error("Expected the held turn to request a sign-in.");
  }
  const callbackUrl = toCallbackUrl(required.data.authorization?.url);
  const resumed = watchNext(t, live.session);
  const response = await fetch(callbackUrl);
  if (!response.ok) {
    throw new Error(`Authorization callback failed (${response.status}).`);
  }
  return { callbackUrl, turn: await resumed.result() };
}

function requireAuthorizationOutcome(
  turn: EveEvalTurn,
  outcome: EveEvalStreamEvent<"authorization.completed">["data"]["outcome"],
): void {
  const completed = turn.events.filter(
    (event): event is EveEvalStreamEvent<"authorization.completed"> =>
      event.type === "authorization.completed",
  );
  if (completed.length !== 1 || completed[0]?.data.outcome !== outcome) {
    throw new Error(`Expected one authorization.completed with outcome "${outcome}".`);
  }
}

function requireMarker(turn: EveEvalTurn, marker: string): void {
  if (!turn.message?.includes(marker)) {
    throw new Error(`Probe did not produce ${marker}.`);
  }
}

function watchNext(t: EveEvalContext, session: SessionCursor) {
  if (session.sessionId === undefined || session.state === undefined) {
    throw new Error("Probe session cursor is incomplete.");
  }
  return t.target.watchTurn(session.sessionId, { startIndex: session.state.streamIndex });
}

export async function runStepAuth(
  t: EveEvalContext,
  scenario: "EXPLICIT" | "IMPLICIT",
): Promise<void> {
  const { turn } = await completeSignIn(t, `WORKFLOW-STEP-AUTH-${scenario}`, (url) =>
    fixtureAuthorizationCallback(t.target.url, url),
  );
  requireAuthorizationOutcome(turn, "authorized");
  requireMarker(turn, "WORKFLOW-STEP-AUTH:authorized");
  t.noFailedActions();
}

export async function runRejectedStepAuth(t: EveEvalContext): Promise<void> {
  const { callbackUrl, turn } = await completeSignIn(t, "WORKFLOW-STEP-AUTH-REJECTED", (url) =>
    fixtureAuthorizationCallback(t.target.url, url),
  );
  requireAuthorizationOutcome(turn, "failed");

  const repeatedCallback = await fetch(callbackUrl);
  if (repeatedCallback.status !== 404) {
    throw new Error("The completed authorization callback must be disposed.");
  }
}
