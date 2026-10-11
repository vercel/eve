import type {
  EveEvalContext,
  EveEvalLiveTurn,
  EveEvalSession,
  EveEvalTurn,
  InputRequest,
} from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

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
  const turnId = owner ?? (await live.waitForEvent("message.received")).data.turnId;
  const turn = (await live.result()).expectOk();
  const replies = turn.events.filter(
    (event) =>
      event.type === "message.completed" &&
      event.data.turnId === turnId &&
      typeof event.data.message === "string" &&
      (typeof expected === "string"
        ? event.data.message === expected
        : expected.test(event.data.message)),
  );
  await t.require(
    replies.length,
    satisfies<number>(
      (count) => count === 1,
      `Exactly one reply matching ${String(expected)} in ${turnId}`,
    ),
  );
  const completions = turn.events.filter(
    (event) => event.type === "turn.completed" && event.data.turnId === turnId,
  );
  await t.require(
    completions.length,
    satisfies<number>((count) => count === 1, `Exactly one completion for ${turnId}`),
  );
  turn.eventOrder([
    { type: "message.completed", data: { turnId, message: expected }, count: 1 },
    { type: "turn.completed", data: { turnId }, count: 1 },
  ]);
  turn.notEvent("input.requested", { data: { turnId } });
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
  const resolved = await live.waitForEvent("input.resolved", {
    data: { resolutions: (items) => items.some((item) => item.requestId === requestId) },
  });
  // The approval held its turn, so the answer resumes that turn instead of starting one.
  const turnId = resolved.data.turnId;
  const turn = await expectReply(t, live, expected, turnId);
  turn.notEvent("turn.started");
  turn.eventOrder([
    {
      type: "input.resolved",
      data: {
        resolutions: (items) =>
          items.some(
            (item) =>
              item.requestId === requestId &&
              item.outcome !== "ignored" &&
              item.outcome !== "invalid",
          ),
      },
      count: 1,
    },
    { type: "message.completed", data: { turnId, message: expected }, count: 1 },
    { type: "turn.completed", data: { turnId }, count: 1 },
  ]);
  return turn;
}

/**
 * A message steered the turn held on this approval, which cancels it: the
 * request resolves as ignored and its call never runs.
 */
export function expectApprovalCancelled(session: EveEvalSession, request: InputRequest) {
  session.event("input.resolved", {
    data: {
      resolutions: (items) =>
        items.some((item) => item.requestId === request.requestId && item.outcome === "ignored"),
    },
    count: 1,
  });
  session.event("action.result", {
    data: { status: "rejected", result: { toolName: request.action.toolName } },
    count: 1,
  });
  expectChangeStillUnexecuted(session, request.action.toolName);
}

export async function expectToolResult(t: EveEvalContext, live: EveEvalLiveTurn, toolName: string) {
  t.log(`Accepted input in ${live.sessionId}; awaiting ${toolName}.`);
  const event = await live.waitForEvent("action.result", { data: { result: { toolName } } });
  t.log(`${toolName} returned before the reply: ${JSON.stringify(event.data)}`);
  return event;
}

export function expectChangeStillUnexecuted(session: EveEvalSession, toolName = "change-a") {
  session.notEvent("action.result", { data: { status: "completed", result: { toolName } } });
}

// A partial approval has no turn boundary to await. Await the real HTTP
// acceptance, then send the next message on that same session's ordered inbox.
/**
 * Approves one request of a batch. The rest of the batch is still open, so the
 * turn stays held and says so again.
 */
export async function submitPartialApproval(
  t: EveEvalContext,
  session: EveEvalSession,
  request: InputRequest,
) {
  const held = await session.respond([{ requestId: request.requestId, optionId: "approve" }]);
  t.log(`Partial approval accepted for ${request.requestId}; the turn is still held.`);
  held.event("turn.waiting", { data: { on: "input" }, count: 1 });
  held.notEvent("input.resolved");
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
  session.event("action.result", {
    data: { result: { toolName: request.action.toolName } },
    count: 1,
  });
}
