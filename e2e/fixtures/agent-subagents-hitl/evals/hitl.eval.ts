import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const GOOG_PRICE = "178.92";

/**
 * Parent/child HITL proxying: the stock-price subagent's tool approval
 * (`approval: once()`) surfaces on the parent stream while the delegation
 * holds the parent turn, the approval routes back down, and the child's
 * result returns to that turn and splices into the parent reply.
 * Parking is server-side.
 */
export default defineEval({
  tags: ["session-inbox"],
  description: "Subagent tool approval proxied through the parent session.",
  timeoutMs: 90_000,

  async test(t) {
    const blocked = await t.send(
      `Call the stock-price subagent exactly once with message 'Call the get_stock_price tool exactly once with ticker "GOOG". After it returns, do not call any tool again; return the result.'. After that single subagent call finishes, do not call any subagent or tool again; include the exact stock price in your final reply.`,
    );
    blocked.expectOk();
    blocked.event("task.started", { data: { name: "stock-price" }, count: 1 });
    blocked.notEvent("task.settled");
    // The proxied approval names the delegated task that asked for it.
    blocked.event("input.requested", {
      data: { taskId: (taskId) => taskId?.startsWith("stock-price-") === true },
      count: 1,
    });
    blocked.session.requireInputRequest({ toolName: "get_stock_price" });

    const resumed = await blocked.session.respondAll("approve");
    resumed.expectOk();
    t.check(resumed.inputRequests, equals([]));
    resumed.event("task.settled", {
      data: {
        output: (output) => JSON.stringify(output ?? null).includes(GOOG_PRICE),
        status: "completed",
      },
      count: 1,
    });
    resumed.messageIncludes(GOOG_PRICE);

    t.succeeded();
    t.calledSubagent("stock-price", { status: "completed", count: 1 });
    t.noFailedActions();
  },
});
