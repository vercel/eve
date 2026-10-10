import { defineEval } from "eve/evals";

/**
 * Alice cancels her turn while the deploy's question waits for her. The
 * cancel stops the run, so nobody can answer what it relayed: the session
 * withdraws the question as cancelled.
 */
export default defineEval({
  description: "Cancelling the turn withdraws the questions relayed through it.",
  tags: ["hitl", "relayed", "cancel"],
  async test(t) {
    const parked = await t.send("WORKFLOW-CONFIRM-START");
    const request = parked.session.requireInputRequest({ toolName: "confirm_deploy" });
    const startIndex = parked.session.state.streamIndex;

    await parked.session.cancel();
    const cancelled = await t.target.watchTurn(parked.sessionId, { startIndex }).result();
    cancelled.event("interaction.settled", {
      count: 1,
      data: { interactionId: request.requestId, outcome: "interrupted" },
    });
    cancelled.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
    cancelled.notEvent("call.settled", {
      data: { callId: request.action.callId, outcome: "completed" },
    });
  },
});
