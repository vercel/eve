import type { EveEvalContext, EveEvalSession, EveEvalStreamEvent, EveEvalTurn } from "eve/evals";

import { fixtureAuthorizationCallback } from "../agent/lib/fake-service.ts";

export type ProbeCase = { readonly kind: "auth" | "hitl" };

type SessionCursor = Pick<
  EveEvalSession,
  "pendingInputRequests" | "requireInputRequest" | "respondAll" | "sessionId" | "state"
>;

export async function runProbe(t: EveEvalContext, probe: ProbeCase): Promise<void> {
  const directive = `WORKFLOW-PROBE-blocking-local-${probe.kind}`;
  const started = await t.send(directive);
  started.expectOk();

  if (probe.kind === "hitl") {
    const blocked = await waitForInput(t, t, "approval-gate");
    const approved = await blocked.respondAll("approve");
    approved.expectOk();
    await waitForMarker(t, blocked, approved, "WORKFLOW-HITL:approved");
  } else {
    const required = await waitForEvent(t, t, started, "authorization.required");
    const url = required.event.data.authorization?.url;
    if (url === undefined) {
      throw new Error("Authorization probe produced no callback URL.");
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Authorization callback failed (${response.status}).`);
    }

    await waitForEvent(t, required.session, undefined, "authorization.completed");
    await waitForMarker(t, required.session, undefined, "WORKFLOW-AUTH:authorized");
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

async function waitForEvent<T extends "authorization.completed" | "authorization.required">(
  t: EveEvalContext,
  initial: SessionCursor,
  initialTurn: EveEvalTurn | undefined,
  type: T,
  options: { allowFailedActions?: boolean } = {},
): Promise<{
  readonly event: EveEvalStreamEvent<T>;
  readonly session: SessionCursor;
}> {
  let session = initial;
  let turn = initialTurn;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const event = turn?.events.find(
      (candidate): candidate is EveEvalStreamEvent<T> => candidate.type === type,
    );
    if (event !== undefined) {
      return { event, session };
    }

    const live = watchNext(t, session);
    turn = await live.result();
    if (!options.allowFailedActions) {
      turn.noFailedActions();
    }
    session = live.session;
  }

  throw new Error(`Probe did not surface ${type}.`);
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
  const started = await t.send(`WORKFLOW-STEP-AUTH-${scenario}`);
  const required = await waitForEvent(t, t, started, "authorization.required");

  const url = fixtureAuthorizationCallback(t.target.url, required.event.data.authorization?.url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Authorization callback failed (${response.status}).`);
  }

  await waitForEvent(t, required.session, undefined, "authorization.completed");
  await waitForMarker(t, required.session, undefined, "WORKFLOW-STEP-AUTH:authorized");
  t.noFailedActions();
}

export async function runRejectedStepAuth(t: EveEvalContext): Promise<void> {
  const started = await t.send("WORKFLOW-STEP-AUTH-REJECTED");
  const required = await waitForEvent(t, t, started, "authorization.required");

  const url = fixtureAuthorizationCallback(t.target.url, required.event.data.authorization?.url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Authorization callback failed (${response.status}).`);
  }

  const completed = await waitForEvent(t, required.session, undefined, "authorization.completed", {
    allowFailedActions: true,
  });
  if (completed.event.data.outcome !== "failed") {
    throw new Error("A token rejected immediately after sign-in must fail authorization.");
  }

  const repeatedCallback = await fetch(url);
  if (repeatedCallback.status !== 404) {
    throw new Error("The completed authorization callback must be disposed.");
  }
}
