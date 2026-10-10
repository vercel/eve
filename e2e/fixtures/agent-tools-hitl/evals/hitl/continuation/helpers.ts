import type {
  EveEvalContext,
  EveEvalEventMatch,
  EveEvalLiveTurn,
  EveEvalSession,
  EveEvalTurn,
  InputRequest,
} from "eve/evals";
import { satisfies } from "eve/evals/expect";

export const scriptedSession = { headers: { "x-eve-fixture-model": "continuation" } };

export function requestFrom(turn: EveEvalTurn, toolName: string): InputRequest {
  turn.expectOk();
  const matches = turn.inputRequests.filter((request) => request.action.toolName === toolName);
  if (matches.length !== 1)
    throw new Error(`Expected one ${toolName} request; found ${matches.length}.`);
  return matches[0]!;
}

export async function expectReply(
  t: EveEvalContext,
  live: EveEvalLiveTurn,
  expected: string | RegExp,
  owner?: string,
): Promise<EveEvalTurn> {
  t.log(`Accepted input in ${live.sessionId}; awaiting the reply and its turn completion.`);
  const turnId = owner ?? (await live.waitForEvent("delivery.consumed")).data.turnId;
  const turn = (await live.result()).expectOk();
  const replies = turn.events.filter(
    (event) =>
      event.type === "content.completed" &&
      event.scope?.turnId === turnId &&
      event.data.kind === "text" &&
      event.data.phase === "reply" &&
      typeof event.data.value === "string" &&
      (typeof expected === "string"
        ? event.data.value === expected
        : expected.test(event.data.value)),
  );
  await t.require(
    replies.length,
    satisfies<number>(
      (count) => count === 1,
      `Exactly one reply matching ${String(expected)} in ${turnId}`,
    ),
  );
  const completions = turn.events.filter(
    (event) =>
      event.type === "turn.settled" &&
      event.data.turnId === turnId &&
      event.data.outcome === "completed",
  );
  await t.require(
    completions.length,
    satisfies<number>((count) => count === 1, `Exactly one completion for ${turnId}`),
  );
  turn.eventOrder([replyMatch(turnId, expected), completionMatch(turnId)]);
  turn.notEvent("interaction.opened", { scope: { turnId } });
  t.log(`Checking answer and completion for ${turnId}.`);
  return turn;
}

export async function expectResponseReply(
  t: EveEvalContext,
  live: EveEvalLiveTurn,
  expected: string | RegExp,
  requestId: string,
): Promise<EveEvalTurn> {
  t.log(`Accepted response for ${requestId}; awaiting resolution and the held turn's reply.`);
  const resolved = await live.waitForEvent("interaction.settled", {
    data: { interactionId: requestId },
  });
  // The approval held its turn, so the answer resumes that turn instead of starting one.
  const turnId = resolved.scope?.turnId;
  if (turnId === undefined) throw new Error(`The settled request ${requestId} names no turn.`);
  const turn = await expectReply(t, live, expected, turnId);
  turn.notEvent("turn.started");
  turn.eventOrder([
    {
      type: "interaction.settled",
      data: {
        interactionId: requestId,
        outcome: (outcome) => outcome !== "withdrawn" && outcome !== "invalid",
      },
      count: 1,
    },
    replyMatch(turnId, expected),
    completionMatch(turnId),
  ]);
  return turn;
}

function replyMatch(turnId: string, expected: string | RegExp): EveEvalEventMatch {
  return {
    count: 1,
    data: { kind: "text", phase: "reply", value: expected },
    scope: { turnId },
    type: "content.completed",
  };
}

function completionMatch(turnId: string): EveEvalEventMatch {
  return { count: 1, data: { outcome: "completed", turnId }, type: "turn.settled" };
}

/**
 * A message steered the turn held on this approval, which cancels it: the
 * request is withdrawn and its call never runs.
 */
export function expectApprovalCancelled(session: EveEvalSession, request: InputRequest) {
  session.event("interaction.settled", {
    data: { interactionId: request.requestId, outcome: "withdrawn" },
    count: 1,
  });
  session.event("call.settled", {
    data: { callId: request.action.callId, outcome: "rejected" },
    count: 1,
  });
  expectChangeStillUnexecuted(session, request.action.toolName);
}

export async function expectToolResult(t: EveEvalContext, live: EveEvalLiveTurn, toolName: string) {
  t.log(`Accepted input in ${live.sessionId}; awaiting ${toolName}.`);
  const call = await live.waitForToolCall(toolName);
  t.log(`${toolName} returned before the reply: ${JSON.stringify(call)}`);
  return call;
}

export function expectChangeStillUnexecuted(session: EveEvalSession, toolName = "change-a") {
  session.calledTool(toolName, { status: "completed", count: 0 });
}

// A partial approval has no turn boundary to await. Await the real HTTP
// acceptance, then send the next message on that same session's ordered inbox.
/**
 * Approves one request of a batch. The rest of the batch is still open, so the
 * turn stays held and the answer's delivery settles awaiting more input.
 */
export async function submitPartialApproval(
  t: EveEvalContext,
  session: EveEvalSession,
  request: InputRequest,
) {
  const held = await session.respond([{ requestId: request.requestId, optionId: "approve" }]);
  t.log(`Partial approval accepted for ${request.requestId}; the turn is still held.`);
  held.event("delivery.settled", { data: { outcome: "awaiting-input" }, count: 1 });
  held.notEvent("interaction.settled");
  held.notEvent("turn.started");
}

export async function approveSavedChange(
  t: EveEvalContext,
  session: EveEvalSession,
  request: InputRequest,
) {
  const live = await session.startRespond([{ requestId: request.requestId, optionId: "approve" }]);
  const approved = await expectResponseReply(t, live, /\S/, request.requestId);
  approved.calledTool(request.action.toolName, {
    status: "completed",
    output: { executions: 1 },
    count: 1,
  });
  session.event("call.settled", { data: { callId: request.action.callId }, count: 1 });
}
