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
    held.event("turn.waiting", { count: 1 });
    held.notEvent("session.waiting");
    const request = session.requireInputRequest({
      display: "confirmation",
      toolName: "guarded-echo",
    });

    const steered = await session.send(
      "Never mind the echo. Do not call any tools. Reply with exactly OPEN-APPROVAL-MSG-OK.",
    );
    steered.expectOk();
    steered.event("input.resolved", {
      count: 1,
      data: {
        resolutions: (resolutions) =>
          resolutions.some(
            (resolution) =>
              resolution.requestId === request.requestId && resolution.outcome === "ignored",
          ),
      },
    });
    steered.notEvent("turn.started");
    steered.messageIncludes(/OPEN-APPROVAL-MSG-OK/i);
    steered.notEvent("action.result", {
      data: { result: { output: new RegExp(GUARDED_ECHO_TOKEN), toolName: "guarded-echo" } },
    });
    steered.event("session.waiting", { count: 1 });

    t.succeeded();
  },
});
