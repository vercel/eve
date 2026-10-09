import { defineEval } from "eve/evals";

import { GUARDED_ECHO_TOKEN } from "./shared";

/**
 * HITL flow: a tool approval holds the turn, as a question or task does. A
 * message from the same person steers that turn and cancels the approval, so
 * the turn moves on with the message and the parked call never runs.
 */
export default defineEval({
  tags: ["real-model"],
  description: "HITL smoke: a message during an approval steers the turn and cancels it.",
  async test(t) {
    const held = await t.send('Call the guarded-echo tool with note "open-approval".');
    const session = held.session;
    held.calledTool("guarded-echo", { status: "pending", count: 1 });
    held.event("turn.paused", { count: 1 });
    held.notEvent("turn.settled");
    const request = session.requireInputRequest({
      display: "confirmation",
      toolName: "guarded-echo",
    });

    const steered = await session.send(
      "Never mind the echo. Do not call any tools. Reply with exactly OPEN-APPROVAL-MSG-OK.",
    );
    steered.expectOk();
    steered.event("interaction.settled", {
      count: 1,
      data: { interactionId: request.requestId, outcome: "withdrawn" },
    });
    steered.notEvent("turn.started");
    steered.messageIncludes(/OPEN-APPROVAL-MSG-OK/i);
    steered.calledTool("guarded-echo", { output: new RegExp(GUARDED_ECHO_TOKEN), count: 0 });
    steered.event("turn.settled", { count: 1, data: { outcome: "completed" } });

    t.succeeded();
  },
});
