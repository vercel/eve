import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import type { InputHookObservation } from "../input-hook-audit";

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

    const audit = await resumed.session.send(
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
              record.sessionId === blocked.sessionId &&
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
