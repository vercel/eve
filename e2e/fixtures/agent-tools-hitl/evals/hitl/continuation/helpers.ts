import type { Interaction } from "eve/events";
import type {
  EveEvalContext,
  EveEvalEventMatch,
  EveEvalLiveTurn,
  EveEvalSession,
  EveEvalTurn,
} from "eve/evals";
import { satisfies } from "eve/evals/expect";

export const scriptedSession = { headers: { "x-eve-fixture-model": "continuation" } };

export function requestFrom(turn: EveEvalTurn, toolName: string): Interaction {
  turn.expectOk();
  const matches = turn.interactions.filter(
    (request) => (request.call?.name ?? request.request.kind) === toolName,
  );
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
  // A turn whose earlier request still waits on a person pauses on it again instead of ending.
  const end = endOf(turn, turnId);
  const completions = turn.events.filter(
    (event) =>
      event.type === "turn.settled" &&
      event.data.turnId === turnId &&
      event.data.outcome === "completed",
  );
  await t.require(
    end === "paused" ? 1 : completions.length,
    satisfies<number>((count) => count === 1, `Exactly one completion for ${turnId}`),
  );
  turn.eventOrder([replyMatch(turnId, expected), endMatch(turnId, end)]);
  turn.notEvent("interaction.opened", { scope: { turnId } });
  t.log(`Checking answer and completion for ${turnId}.`);
  return turn;
}

export async function expectResponseReply(
  t: EveEvalContext,
  live: EveEvalLiveTurn,
  expected: string | RegExp,
  interactionId: string,
): Promise<EveEvalTurn> {
  t.log(`Accepted response for ${interactionId}; awaiting resolution and the held turn's reply.`);
  const resolved = await live.waitForEvent("interaction.settled", {
    data: { interactionId: interactionId },
  });
  // The approval held its turn, so the answer resumes that turn instead of starting one.
  const turnId = resolved.scope?.turnId;
  if (turnId === undefined) throw new Error(`The settled request ${interactionId} names no turn.`);
  const turn = await expectReply(t, live, expected, turnId);
  turn.notEvent("turn.started");
  turn.eventOrder([
    {
      type: "interaction.settled",
      data: {
        interactionId: interactionId,
        outcome: (outcome) => outcome !== "withdrawn" && outcome !== "invalid",
      },
      count: 1,
    },
    replyMatch(turnId, expected),
    endMatch(turnId, endOf(turn, turnId)),
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

/**
 * How `turnId` ended in `turn`: settled, or paused again on a request that still waits, with no
 * `turn.settled` after it.
 */
function endOf(turn: EveEvalTurn, turnId: string): "paused" | "settled" {
  const last = [...turn.events]
    .reverse()
    .find(
      (event) =>
        (event.type === "turn.paused" || event.type === "turn.settled") &&
        event.data.turnId === turnId,
    );
  return last?.type === "turn.paused" && last.data.awaiting.length > 0 ? "paused" : "settled";
}

function endMatch(turnId: string, end: "paused" | "settled"): EveEvalEventMatch {
  return end === "paused"
    ? { data: { turnId }, type: "turn.paused" }
    : { count: 1, data: { outcome: "completed", turnId }, type: "turn.settled" };
}

/**
 * A message joined the turn held on this approval, which stays open: its call waits as a task
 * and hasn't run.
 */
export function expectApprovalStillOpen(session: EveEvalSession, request: Interaction) {
  session.notEvent("interaction.settled", { data: { interactionId: request.interactionId } });
  session.notEvent("call.settled", { data: { callId: request.call!.callId } });
  expectChangeStillUnexecuted(session, request.call!.name);
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
  request: Interaction,
) {
  const held = await session.respond([
    { interactionId: request.interactionId, optionId: "approve" },
  ]);
  t.log(`Partial approval accepted for ${request.interactionId}; the turn is still held.`);
  held.event("delivery.settled", { data: { outcome: "awaiting-input" }, count: 1 });
  held.notEvent("interaction.settled");
  held.notEvent("turn.started");
}

export async function approveSavedChange(
  t: EveEvalContext,
  session: EveEvalSession,
  request: Interaction,
) {
  const live = await session.startRespond([
    { interactionId: request.interactionId, optionId: "approve" },
  ]);
  const approved = await expectResponseReply(t, live, /\S/, request.interactionId);
  approved.calledTool(request.call!.name, {
    status: "completed",
    output: { executions: 1 },
    count: 1,
  });
  session.event("call.settled", { data: { callId: request.call!.callId }, count: 1 });
}
