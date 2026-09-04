import { defineEval } from "eve/evals";
import type { EveEvalContext, EveEvalSession, EveEvalTurn } from "eve/evals";
import { equals } from "eve/evals/expect";

const GOOG_PRICE = "178.92";

type SessionCursor = Pick<
  EveEvalSession,
  "pendingInputRequests" | "requireInputRequest" | "respondAll" | "sessionId" | "state"
>;

/**
 * Parent/child HITL proxying: the stock-price subagent's tool approval
 * (`approval: once()`) surfaces on the parent stream, the approval
 * routes back down, and the child's result splices into the parent reply.
 * Parking is server-side.
 */
export default defineEval({
  tags: ["session-inbox"],
  description: "Subagent tool approval proxied through the parent session.",
  timeoutMs: 90_000,

  async test(t) {
    const started = await t.send(
      `Call the stock-price subagent exactly once with message 'Call the get_stock_price tool exactly once with ticker "GOOG". After it returns, do not call any tool again; return the result.'. After that single subagent call finishes, do not call any subagent or tool again; include the exact stock price in your final reply.`,
    );
    started.event("subagent.completed", {
      count: 1,
      data: {
        backgroundTask: { status: "working" },
        subagentName: "stock-price",
      },
    });

    // Background delegation returns its receipt first. The child's approval
    // then wakes the parent in a separate server-initiated turn.
    const blocked = await waitForInput(t, t, "get_stock_price");
    const resumed = await blocked.respondAll("approve");
    t.check(resumed.inputRequests, equals([]));
    resumed.noFailedActions();
    const completed = resumed.message?.includes(GOOG_PRICE)
      ? resumed
      : await waitForMessage(t, blocked, GOOG_PRICE);
    completed.messageIncludes(GOOG_PRICE);

    t.succeeded();
    t.calledSubagent("stock-price", {
      count: 1,
    });
    t.noFailedActions();
  },
});

async function waitForInput(
  t: EveEvalContext,
  initialSession: SessionCursor,
  toolName: string,
): Promise<SessionCursor> {
  let session = initialSession;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (session.pendingInputRequests.some((request) => request.action.toolName === toolName)) {
      session.requireInputRequest({ toolName });
      return session;
    }
    const live = watchNextTurn(t, session, "subagent input wait");
    const turn = await live.result();
    turn.noFailedActions();
    session = live.session;
  }
  throw new Error(`Subagent did not surface input for tool "${toolName}" after five turns.`);
}

async function waitForMessage(
  t: EveEvalContext,
  initialSession: SessionCursor,
  marker: string,
): Promise<EveEvalTurn> {
  let session = initialSession;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const live = watchNextTurn(t, session, "subagent completion wait");
    const turn = await live.result();
    turn.noFailedActions();
    if (turn.message?.includes(marker) === true) return turn;
    session = live.session;
  }
  throw new Error(`Subagent result did not reach the parent after five turns.`);
}

function watchNextTurn(t: EveEvalContext, session: SessionCursor, operation: string) {
  if (session.sessionId === undefined || session.state === undefined) {
    throw new Error(`${operation} has no parent session cursor.`);
  }
  return t.target.watchTurn(session.sessionId, { startIndex: session.state.streamIndex });
}
