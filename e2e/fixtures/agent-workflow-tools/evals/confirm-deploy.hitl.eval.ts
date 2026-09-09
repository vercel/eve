import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A workflow tool reports progress around a human question, then settles the call in order.",
  async test(t) {
    const live = await t.start("WORKFLOW-CONFIRM-START");
    const requested = await live.waitForEvent("input.requested");
    const response = await t.target.fetch(`/eve/v1/session/${live.sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inputResponses: requested.data.requests.map((request) => ({
          requestId: request.requestId,
          optionId: "approve",
        })),
      }),
    });
    if (!response.ok) throw new Error("The approval was not accepted.");
    const approved = await live.result();
    approved.event("action.partial", {
      count: (count) => count >= 1,
      data: { result: { toolName: "confirm_deploy", output: "awaiting approval" } },
    });
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
