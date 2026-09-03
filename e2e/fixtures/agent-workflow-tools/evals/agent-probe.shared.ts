import type { EveEvalContext, EveEvalSession, EveEvalTurn } from "eve/evals";

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
    if (url === undefined) throw new Error("Authorization probe produced no callback URL.");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Authorization callback failed (${response.status}).`);
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
  if (initialTurn?.message?.includes(marker) === true) return initialTurn;
  let session = initial;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const live = watchNext(t, session);
    const turn = await live.result();
    turn.noFailedActions();
    if (turn.message?.includes(marker) === true) return turn;
    session = live.session;
  }
  throw new Error(`Probe did not produce ${marker}.`);
}

async function waitForEvent<T extends "authorization.completed" | "authorization.required">(
  t: EveEvalContext,
  initial: SessionCursor,
  initialTurn: EveEvalTurn | undefined,
  type: T,
): Promise<{
  readonly event: Extract<EveEvalTurn["events"][number], { readonly type: T }>;
  readonly session: SessionCursor;
}> {
  let session = initial;
  let turn = initialTurn;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const event = turn?.events.find(
      (candidate): candidate is Extract<EveEvalTurn["events"][number], { readonly type: T }> =>
        candidate.type === type,
    );
    if (event !== undefined) return { event, session };
    const live = watchNext(t, session);
    turn = await live.result();
    turn.noFailedActions();
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
