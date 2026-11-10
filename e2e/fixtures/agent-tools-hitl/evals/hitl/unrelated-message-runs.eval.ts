import { defineEval } from "eve/evals";

import { GUARDED_ECHO_TOKEN } from "./shared";

/**
 * HITL flow: a tool approval holds the turn. A message from the same person joins that turn while
 * the approval stays open, so the model answers the message and the call waits. Approving it
 * afterwards runs the call, and the turn ends once the model has its result.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "HITL smoke: a message during an approval joins the turn and keeps the approval open.",
  async test(t) {
    const held = await t.send('Call the guarded-echo tool with note "open-approval".');
    const session = held.session;
    held.calledTool("guarded-echo", { status: "pending", count: 1 });
    held.event("turn.paused", { count: 1 });
    held.notEvent("turn.settled");
    const request = session.requireInteraction({
      display: "confirmation",
      toolName: "guarded-echo",
    });

    const joined = await session.send(
      "While that echo waits for my approval, do not call any tools. Reply with exactly OPEN-APPROVAL-MSG-OK.",
    );
    joined.expectOk();
    joined.notEvent("interaction.settled", { data: { interactionId: request.interactionId } });
    joined.notEvent("turn.started");
    joined.notEvent("turn.settled");
    joined.messageIncludes(/OPEN-APPROVAL-MSG-OK/i);
    joined.calledTool("guarded-echo", { output: new RegExp(GUARDED_ECHO_TOKEN), count: 0 });

    const approved = await session.respond([
      { optionId: "approve", interactionId: request.interactionId },
    ]);
    approved.expectOk();
    approved.event("interaction.settled", {
      count: 1,
      data: { interactionId: request.interactionId, outcome: "accepted" },
    });
    approved.calledTool("guarded-echo", { output: new RegExp(GUARDED_ECHO_TOKEN), count: 1 });
    approved.event("turn.settled", { count: 1, data: { outcome: "completed" } });

    t.succeeded();
  },
});
