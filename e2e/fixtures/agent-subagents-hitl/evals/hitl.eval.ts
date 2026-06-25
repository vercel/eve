import type { HandleMessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const GOOG_PRICE = "178.92";

/**
 * The child's executed tool result does not surface as a parent-stream
 * `action.result`; the child's output reaches the parent through
 * `subagent.completed`.
 */
function subagentOutputs(events: readonly HandleMessageStreamEvent[]): string[] {
  const outputs: string[] = [];
  for (const event of events) {
    if (event.type !== "subagent.completed") continue;
    outputs.push(JSON.stringify(event.data.output ?? ""));
  }
  return outputs;
}

/**
 * Parent/child HITL proxying: the stock-price subagent's tool approval
 * (`approval: () => "user-approval"`) surfaces on the parent stream, the approval
 * routes back down, and the child's result splices into the parent reply.
 * Parking is server-side.
 */
export default defineEval({
  description: "Subagent tool approval proxied through the parent session.",

  async test(t) {
    await t.send(
      `Use the stock-price subagent with message 'Call the get_stock_price tool with ticker "GOOG".'. When it finishes, include the exact stock price in your reply.`,
    );

    // The child's approval request must surface on the parent stream.
    t.expectInputRequests({ toolName: "get_stock_price" });

    await t.sleep();

    const resumed = await t.respondAll("approve");
    resumed.expectOk();

    if (resumed.inputRequests.length > 0) {
      const requests = resumed.inputRequests.map((request) => ({
        requestId: request.requestId,
        toolName: request.action.kind === "tool-call" ? request.action.toolName : undefined,
      }));
      throw new Error(
        `Subagent re-parked after approval with input requests: ${JSON.stringify(requests)}.`,
      );
    }

    const outputs = subagentOutputs(t.events);
    if (!outputs.some((output) => output.includes(GOOG_PRICE))) {
      const failedActions = t.events.flatMap((event) => {
        if (event.type !== "action.result") return [];
        if (event.data.status !== "failed" && event.data.result.isError !== true) return [];
        return [event.data.result];
      });
      const recentEventTypes = t.events.slice(-20).map((event) => event.type);
      throw new Error(
        [
          `No subagent.completed output contained the GOOG price; got [${outputs.join(", ")}].`,
          `Resumed turn status: ${resumed.status}.`,
          `Failed actions: ${JSON.stringify(failedActions)}.`,
          `Recent events: [${recentEventTypes.join(", ")}].`,
        ].join(" "),
      );
    }

    t.noFailedActions();
    t.didNotFail();
    t.completed();
    t.messageIncludes(GOOG_PRICE);
  },
});
