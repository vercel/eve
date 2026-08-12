import { defineEval } from "eve/evals";

import { gateLifecycle, verifyFollowUp } from "./shared";

export default defineEval({
  tags: ["real-model"],
  metadata: { transition: "projector.route.close.project" },
  description:
    "projector.route.close.project: a denied child request projects its settlement and keeps the parent active.",
  async test(t) {
    gateLifecycle(t);
    const parked = await t.send(
      `Call the stock-price subagent exactly once with message 'Call get_stock_price exactly once for ticker "GOOG". If it is denied, report that denial and stop.'. Do not call it again.`,
    );
    const request = t.requireInputRequest({
      optionIds: ["approve", "deny"],
      toolName: "get_stock_price",
    });

    const denied = await t.respondAll("deny");
    denied.expectOk();
    denied.event("session.waiting", { count: 1 });
    denied.eventsSatisfy("the child-owned denial closes the parent projection once", (events) => {
      const matching = events.filter((event) => {
        const candidate = event as {
          readonly data?: Record<string, unknown>;
          readonly type: string;
        };
        if (candidate.type !== "input.responded" || candidate.data === undefined) return false;
        const data = candidate.data;
        return (
          data.requestId === request.requestId &&
          data.scope === "projection" &&
          data.outcome === "denied"
        );
      });
      return matching.length === 1;
    });
    denied.eventsSatisfy("child tool is rejected once and never completes", (events) => {
      const results = events.flatMap((event) =>
        event.type === "subagent.event" && event.data.event.type === "action.result"
          ? [event.data.event]
          : [],
      );
      const stockResults = results.filter(
        (event) =>
          event.data.result.kind === "tool-result" &&
          event.data.result.toolName === "get_stock_price",
      );
      return (
        stockResults.filter((event) => event.data.status === "rejected").length === 1 &&
        stockResults.every((event) => event.data.status !== "completed")
      );
    });
    t.noFailedActions();
    t.succeeded();
    t.calledSubagent("stock-price", { count: 1 });
    t.judge.autoevals
      .closedQA("The response says the stock-price tool was denied and did not run.", {
        on: denied.message,
      })
      .atLeast(0.5);

    await verifyFollowUp(t, parked.sessionId, "PROXY-DENY-FOLLOW-UP-OK");
  },
});
