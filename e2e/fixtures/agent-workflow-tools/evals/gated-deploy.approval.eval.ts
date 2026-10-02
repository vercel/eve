import { defineEval } from "eve/evals";

export default defineEval({
  description: "A workflow body starts only after approval and never starts after denial.",
  async test(t) {
    const review = await t.session();
    const denied = await review.send(
      "WORKFLOW-APPROVAL-DENIED-START Alice requests a review-only release; Bob's policy does not permit deployment.",
    );
    denied.expectOk();
    denied.messageIncludes("WORKFLOW-APPROVAL-DENIED-RESULT");
    denied.notEvent("input.requested");
    denied.notEvent("action.partial");
    denied.calledTool("gated_deploy", {
      count: 1,
      output: /Tool execution was denied/u,
      status: "rejected",
    });

    for (const decision of ["approve", "cancel"] as const) {
      const session = await t.session();
      const parked = await session.send(
        "WORKFLOW-APPROVAL-START Alice asks Bob to review the API release before deployment.",
      );
      session.requireInputRequest({ toolName: "gated_deploy", display: "confirmation" });
      parked.calledTool("gated_deploy", { count: 1, status: "pending" });
      parked.notEvent("action.partial");
      parked.notEvent("action.result");
      // The approval holds the turn, so answering it resumes that turn.
      parked.event("turn.waiting", { count: 1 });
      parked.notEvent("session.waiting");

      const resumed = await session.respondAll(decision);
      resumed.expectOk();
      resumed.notEvent("turn.started");
      resumed.event("input.resolved", { count: 1 });
      resumed.messageIncludes("WORKFLOW-APPROVAL-RESULT");
      if (decision === "approve") {
        resumed.event("action.partial", {
          count: 1,
          data: { result: { toolName: "gated_deploy", output: "approved deployment started" } },
        });
        resumed.calledTool("gated_deploy", { status: "completed", output: /api/u });
        resumed.eventOrder([
          { type: "input.resolved" },
          { type: "action.partial" },
          { type: "action.result" },
          { type: "turn.completed" },
        ]);
      } else {
        resumed.notEvent("action.partial");
        resumed.event("action.result", {
          count: 1,
          data: { status: "rejected", result: { toolName: "gated_deploy" } },
        });
      }
    }
  },
});
