import { defineEval } from "eve/evals";
import type { EveEvalContext, EveEvalSession, EveEvalTurn } from "eve/evals";

const GOOG_PRICE = "178.92";

/**
 * A text-only channel can't press Approve, so a typed reply at the parent must
 * settle the subagent's proxied tool approval rather than reach the parent model.
 */
export default defineEval({
  tags: ["session-inbox"],
  description: "Plain-text approve at the parent runs a delegated child's gated tool.",
  timeoutMs: 90_000,

  async test(t) {
    const started = await t.send(
      `Call the stock-price subagent exactly once with message 'Call the get_stock_price tool exactly once with ticker "GOOG". After it returns, do not call any tool again; return the result.'. After that single subagent call finishes, do not call any subagent or tool again; include the exact stock price in your final reply.`,
    );
    const blocked = await waitForInput(t, started.session, "get_stock_price");
    const resumed = await blocked.send("approve");
    resumed.noFailedActions();
    const completed = resumed.message?.includes(GOOG_PRICE)
      ? resumed
      : await waitForMessage(t, blocked, GOOG_PRICE);
    completed.messageIncludes(GOOG_PRICE);

    t.calledSubagent("stock-price", { status: "completed", count: 1 });
    t.noFailedActions();
  },
});

async function waitForInput(
  t: EveEvalContext,
  initialSession: EveEvalSession,
  toolName: string,
): Promise<EveEvalSession> {
  let session = initialSession;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (session.pendingInputRequests.some((request) => request.action.toolName === toolName)) {
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
  initialSession: EveEvalSession,
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

function watchNextTurn(t: EveEvalContext, session: EveEvalSession, operation: string) {
  if (session.sessionId === undefined || session.state === undefined) {
    throw new Error(`${operation} has no parent session cursor.`);
  }
  return t.target.watchTurn(session.sessionId, { startIndex: session.state.streamIndex });
}
