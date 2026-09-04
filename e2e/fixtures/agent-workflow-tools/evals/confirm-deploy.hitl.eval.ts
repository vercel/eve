import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A workflow tool reports progress around a human question, then settles the call in order.",
  async test(t) {
    const parked = await t.send("WORKFLOW-CONFIRM-START");
    t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "cancel"],
      toolName: "confirm_deploy",
    });
    parked.event("action.partial", {
      count: (count) => count >= 1,
      data: { result: { toolName: "confirm_deploy", output: "awaiting approval" } },
    });
    parked.calledTool("confirm_deploy", { status: "pending", count: 1 });

    const approved = await t.respondAll("approve");
    approved.expectOk();
    approved.event("action.result", {
      count: 1,
      data: {
        result: {
          kind: "tool-result",
          output: /"approved":true/u,
          toolName: "confirm_deploy",
        },
        status: "completed",
      },
    });
    approved.eventsSatisfy("progress arrives before the final workflow result", (events) => {
      const progress = events.findIndex(
        (event) =>
          event.type === "action.partial" && event.data.result.output === "approval received",
      );
      const result = events.findIndex(
        (event) =>
          event.type === "action.result" &&
          event.data.result.kind === "tool-result" &&
          event.data.result.toolName === "confirm_deploy",
      );
      return progress >= 0 && result > progress;
    });
    approved.messageIncludes("WORKFLOW-CONFIRM-RESULT");
    t.noFailedActions();
  },
});
