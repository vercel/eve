import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A workflow tool asks the human mid-body; the answer resumes the run and the result settles the call.",
  async test(t) {
    const parked = await t.send("WORKFLOW-CONFIRM-START");
    t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "cancel"],
      toolName: "confirm_deploy",
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
    approved.messageIncludes("WORKFLOW-CONFIRM-RESULT");
    t.noFailedActions();
  },
});
