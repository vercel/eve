import { defineEval } from "eve/evals";

/**
 * A steering message aborts the `abortSignal` of the `offer_deploy` call the
 * turn waits on, which withdraws its question: `interaction.settled` reports it
 * withdrawn, and the call returns that the offer was withdrawn.
 *
 * The withdrawal belongs to the parked turn, not to Alice's message, so the
 * eval follows the session stream to see it, as a channel does.
 */
export default defineEval({
  description: "A steering message withdraws a waited call's question as cancelled.",
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
    followed.event("interaction.settled", {
      count: 1,
      data: { interactionId: request.requestId, outcome: "withdrawn" },
    });
    const offerCallId = moved.toolCalls.find((call) => call.name === "offer_deploy")?.callId;
    followed.eventOrder([
      { data: { interactionId: request.requestId }, type: "interaction.settled" },
      { data: { callId: offerCallId }, type: "call.settled" },
    ]);
    t.noFailedActions();
  },
});
