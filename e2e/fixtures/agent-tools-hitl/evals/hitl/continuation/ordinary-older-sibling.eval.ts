import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { expectApprovalStillOpen, requestFrom, scriptedSession } from "./helpers.ts";

export default defineEval({
  description:
    "Answering an older approval that waits as a task runs it while a newer approval holds the turn.",
  tags: ["hitl", "continuation", "regression", "input-response", "approval", "authorization"],
  timeoutMs: 60_000,
  async test(t) {
    // Given A's approval stays open after the user asked for an authorized change.
    const first = await t.send("Prepare change A.", scriptedSession);
    const approvalA = requestFrom(first, "change-a");
    const session = first.session;
    const second = await session.send("Prepare an authorized change, then read the draft status.");
    const newer = requestFrom(second, "authorized-change");
    expectApprovalStillOpen(session, approvalA);
    // When the user answers A from its prompt.
    const answered = await session.respond([
      { interactionId: approvalA.interactionId, optionId: "approve" },
    ]);
    // Then A runs once in the held turn. The newer approval still holds the turn, so the model
    // reads A's result only once that approval is answered.
    answered.expectOk();
    answered.notEvent("turn.started");
    answered.event("interaction.settled", {
      count: 1,
      data: { interactionId: approvalA.interactionId, outcome: "accepted" },
    });
    answered.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    answered.notEvent("model.started");
    expectApprovalStillOpen(session, newer);
    t.check(session.pendingInteractions.length, equals(1));
  },
});
