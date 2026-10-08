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
    cancelled.event("input.resolved", {
      count: 1,
      data: { resolutions: [{ outcome: "cancelled", requestId: request.requestId }] },
    });
    cancelled.event("turn.cancelled", { count: 1 });
    cancelled.notEvent("action.result", {
      data: { status: "completed", result: { toolName: "confirm_deploy" } },
    });
  },
});
