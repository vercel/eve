import { defineEval } from "eve/evals";

/**
 * Alice's quick-deploy offer asks a question through her session and lapses
 * after a few seconds without withdrawing it. Once the run ends nobody can
 * answer it, so the session withdraws it as cancelled before the call's result.
 */
export default defineEval({
  description: "A workflow run that ends withdraws the question it relayed.",
  tags: ["hitl", "relayed"],
  async test(t) {
    const parked = await t.send("WORKFLOW-LAPSE-START Alice offers a quick deploy of the api.");
    const request = parked.session.requireInputRequest({ toolName: "lapsing_offer" });
    const startIndex = parked.session.state.streamIndex;

    const lapsed = (await t.target.watchTurn(parked.sessionId, { startIndex }).result()).expectOk();
    lapsed.event("input.resolved", {
      count: 1,
      data: { resolutions: [{ outcome: "cancelled", requestId: request.requestId }] },
    });
    lapsed.eventOrder([
      { type: "input.resolved" },
      { type: "action.result", data: { result: { toolName: "lapsing_offer" } } },
      { type: "turn.completed" },
    ]);
    lapsed.calledTool("lapsing_offer", { output: { offer: "lapsed" }, count: 1 });
    lapsed.messageIncludes('WORKFLOW-LAPSE-RESULT {"offer":"lapsed","service":"api"}');
  },
});
