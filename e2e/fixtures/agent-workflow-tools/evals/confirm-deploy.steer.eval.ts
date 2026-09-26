import { defineEval } from "eve/evals";

const ALICE_UPDATE = "Alice mentions that the release notes are ready.";

/**
 * `confirm_deploy` asks for approval without passing its `interruptSignal`,
 * so a steering message does not stop it: the question stays pending, and
 * approving it still settles the call. The model reads Alice's message in the
 * same turn, once the call settles.
 */
export default defineEval({
  description: "Steering does not stop a workflow tool waiting on an approval.",
  async test(t) {
    const parked = await t.send("WORKFLOW-CONFIRM-START");
    const request = parked.session.requireInputRequest({ toolName: "confirm_deploy" });
    const afterQuestion = parked.session.state.streamIndex;

    const update = await parked.session.start(ALICE_UPDATE, { turnPolicy: "steer" });
    // Let the steering message reach the waiting turn before anyone answers.
    await t.sleep(2_000);
    const approved = await update.session.respond([
      { optionId: "approve", requestId: request.requestId },
    ]);
    await update.result();
    approved.expectOk();
    approved.calledTool("confirm_deploy", { count: 1, output: { approved: true } });
    approved.event("message.received", { count: 1, data: { message: ALICE_UPDATE } });
    approved.messageIncludes('WORKFLOW-CONFIRM-RESULT {"approved":true');

    // Follow the stream as a channel does: the only resolution is the approval.
    const followed = await t.target
      .watchTurn(parked.sessionId, { startIndex: afterQuestion })
      .result();
    followed.event("input.resolved", {
      count: 1,
      data: { resolutions: [{ outcome: "answered", requestId: request.requestId }] },
    });
    followed.event("turn.completed", { count: 1 });
    followed.notEvent("turn.cancelled");
    t.noFailedActions();
  },
});
