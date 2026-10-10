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
    denied.notEvent("interaction.opened");
    denied.notEvent("call.progress");
    denied.calledTool("gated_deploy", {
      count: 1,
      output: /Tool execution was denied/u,
      status: "failed",
    });

    for (const decision of ["approve", "cancel"] as const) {
      const session = await t.session();
      const parked = await session.send(
        "WORKFLOW-APPROVAL-START Alice asks Bob to review the API release before deployment.",
      );
      session.requireInputRequest({ toolName: "gated_deploy", display: "confirmation" });
      parked.calledTool("gated_deploy", { count: 1, status: "pending" });
      parked.notEvent("call.progress");
      parked.notEvent("call.settled");
      // The approval holds the turn, so answering it resumes that turn.
      parked.event("turn.paused", { count: 1 });
      parked.notEvent("turn.settled");

      const resumed = await session.respondAll(decision);
      resumed.expectOk();
      resumed.notEvent("turn.started");
      resumed.event("interaction.settled", { count: 1 });
      resumed.messageIncludes("WORKFLOW-APPROVAL-RESULT");
      if (decision === "approve") {
        resumed.event("call.progress", {
          count: 1,
          data: { output: "approved deployment started" },
        });
        resumed.calledTool("gated_deploy", { status: "completed", output: /api/u });
        resumed.eventOrder([
          { type: "interaction.settled" },
          { type: "call.progress" },
          { type: "call.settled" },
          { type: "turn.settled", data: { outcome: "completed" } },
        ]);
      } else {
        resumed.notEvent("call.progress");
        resumed.calledTool("gated_deploy", { status: "rejected", count: 1 });
      }
    }
  },
});
