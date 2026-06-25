import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const GOOG_PRICE = "178.92";

/**
 * Parent/child HITL proxying: the stock-price subagent's tool approval
 * (`approval: once()`) surfaces on the parent stream, the approval
 * routes back down, and the child's result splices into the parent reply.
 * Parking is server-side.
 */
export default defineEval({
  description: "Subagent tool approval proxied through the parent session.",

  async test(t) {
    await t.send(
      `Call the stock-price subagent exactly once with message 'Call the get_stock_price tool exactly once with ticker "GOOG". After it returns, do not call any tool again; return the result.'. After that single subagent call finishes, do not call any subagent or tool again; include the exact stock price in your final reply.`,
    );

    // The child's approval request must surface on the parent stream.
    t.requireInputRequest({ toolName: "get_stock_price" });

    await t.sleep();

    const resumed = await t.respondAll("approve");
    t.check(resumed.inputRequests, equals([]));
    t.noFailedActions();
    t.succeeded();
    t.calledSubagent("stock-price", {
      output: new RegExp(GOOG_PRICE),
      count: 1,
    });
    t.messageIncludes(GOOG_PRICE);
  },
});
