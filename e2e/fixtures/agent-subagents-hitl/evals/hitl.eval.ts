import { defineEval } from "eve/evals";
import type { EveEvalContext, EveEvalSession, EveEvalTurn } from "eve/evals";
import { equals } from "eve/evals/expect";
import type { InputHookObservation } from "../input-hook-audit";

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
    started.event("action.result", {
      count: 1,
      data: {
        result: { kind: "tool-result", output: { status: "working" }, toolName: "stock-price" },
      },
    });

    // Background delegation returns its receipt first. The child's approval
    // then wakes the parent in a separate server-initiated turn.
    const blocked = await waitForInput(t, started.session, "get_stock_price");
    const resumed = await blocked.respondAll("approve");
    t.check(resumed.inputRequests, equals([]));
    resumed.noFailedActions();
    const completed = resumed.message?.includes(GOOG_PRICE)
      ? resumed
      : await waitForMessage(t, blocked, GOOG_PRICE);
    completed.messageIncludes(GOOG_PRICE);

    const audit = await completed.session.send(
      "Alice reviews Bob's stock-price approval. Read the parent input-hook audit.",
    );
    audit.expectOk();
    audit.calledTool("read_input_hooks", { count: 1, status: "completed" });
    const observations = audit.toolCalls.find((call) => call.name === "read_input_hooks")?.output;
    t.eventsSatisfy(
      "parent input hooks record the published approval once per subscriber",
      (events) => {
        if (!Array.isArray(observations) || observations.length !== 2) return false;
        const approvals = events.filter((event) => event.type === "input.requested");
        const approval = approvals[0];
        if (approvals.length !== 1 || approval?.type !== "input.requested") return false;
        const records = observations as InputHookObservation[];
        return (
          records.every(
            (record) =>
              record.sessionId === started.sessionId &&
              record.eventId === approval.meta.id &&
              record.requestIds.length === approval.data.requests.length &&
              record.requestIds.every(
                (id, index) => id === approval.data.requests[index]?.requestId,
              ),
          ) &&
          (["typed", "wildcard"] as const).every(
            (subscriber) =>
              records.filter((record) => record.subscriber === subscriber).length === 1,
          )
        );
      },
    );

    t.succeeded();
    t.calledSubagent("stock-price", { status: "completed", count: 1 });
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
