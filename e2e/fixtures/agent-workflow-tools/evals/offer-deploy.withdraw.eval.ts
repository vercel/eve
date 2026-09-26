import { defineEval } from "eve/evals";

/**
 * `offer_deploy` passes its `interruptSignal` to `ctx.ask`. A steering
 * message withdraws the question: `input.resolved` reports it as cancelled,
 * and the call returns that the offer was withdrawn.
 *
 * The withdrawal belongs to the parked turn, not to Alice's message, so the
 * eval follows the session stream to see it, as a channel does.
 */
export default defineEval({
  description: "A question asked with the interruptSignal is withdrawn as cancelled on steering.",
  async test(t) {
    const parked = await t.send("WORKFLOW-OFFER-START");
    const request = parked.session.requireInputRequest({ toolName: "offer_deploy" });
    const afterQuestion = parked.session.state.streamIndex;

    const moved = await parked.session.send(
      "Alice wants Bob to review the plan before any deploy.",
      { turnPolicy: "steer" },
    );
    moved.expectOk();
    moved.calledTool("offer_deploy", { count: 1, output: { offer: "withdrawn" } });
    moved.messageIncludes('WORKFLOW-OFFER-RESULT {"offer":"withdrawn","service":"api"}');

    const followed = await t.target
      .watchTurn(parked.sessionId, { startIndex: afterQuestion })
      .result();
    followed.event("input.resolved", {
      count: 1,
      data: { resolutions: [{ outcome: "cancelled", requestId: request.requestId }] },
    });
    followed.eventOrder([
      { type: "input.resolved" },
      { data: { result: { toolName: "offer_deploy" } }, type: "action.result" },
    ]);
    t.noFailedActions();
  },
});
