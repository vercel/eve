import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A workflow tool reports progress around a human question, then settles the call in order.",
  async test(t) {
    const parked = await t.send("WORKFLOW-CONFIRM-START");
    const session = parked.session;
    session.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "cancel"],
      toolName: "confirm_deploy",
    });
    parked.calledTool("confirm_deploy", { status: "pending", count: 1 });
    const callId = parked.toolCalls.find((call) => call.name === "confirm_deploy")?.callId;
    parked.event("call.progress", {
      count: (count) => count >= 1,
      data: { callId, output: "awaiting approval" },
    });

    const approved = await session.respondAll("approve");
    approved.expectOk();
    approved.calledTool("confirm_deploy", {
      count: 1,
      output: /"approved":true/u,
      status: "completed",
    });
    approved.eventsSatisfy("progress arrives before the final workflow result", (events) => {
      const progress = events.findIndex(
        (event) =>
          event.type === "call.progress" &&
          event.data.callId === callId &&
          event.data.output === "approval received",
      );
      const result = events.findIndex(
        (event) => event.type === "call.settled" && event.data.callId === callId,
      );
      return progress >= 0 && result > progress;
    });
    approved.messageIncludes("WORKFLOW-CONFIRM-RESULT");
    t.noFailedActions();
  },
});
