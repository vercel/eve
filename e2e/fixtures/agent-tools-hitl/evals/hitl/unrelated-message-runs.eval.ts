import { defineEval } from "eve/evals";

import { GUARDED_ECHO_TOKEN } from "./shared";

/**
 * HITL flow: unrelated text sent while an approval is pending must not deny
 * the approval and must not wait behind it. The message runs as an ordinary
 * turn, the approval stays answerable, and a later structured approval still
 * runs the original tool call exactly once.
 */
export default defineEval({
  tags: ["real-model"],
  description: "HITL smoke: unrelated message during approval runs immediately.",
  async test(t) {
    const parked = await t.send('Call the guarded-echo tool with note "open-approval".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({
      display: "confirmation",
      toolName: "guarded-echo",
    });

    // The message runs now; the approval is untouched.
    const message = await t.send(
      "Leave the pending approval alone. Do not call any tools. Reply with exactly OPEN-APPROVAL-MSG-OK.",
    );
    message.expectOk();
    message.event("message.received", { count: 1 });
    message.event("message.completed", { count: 1 });
    message.messageIncludes(/OPEN-APPROVAL-MSG-OK/i);
    // The parked call must not execute — and the intervening turn must not
    // run any tool of its own either.
    message.notEvent("action.result", {
      data: { result: { toolName: "guarded-echo" } },
    });
    message.usedNoTools();
    message.event("session.waiting", { count: 1 });

    // The approval still resolves afterwards and runs the tool once.
    const approved = await t.respond([
      {
        requestId: request.requestId,
        optionId: "approve",
      },
    ]);
    approved.expectOk();
    approved.event("action.result", {
      data: {
        result: {
          kind: "tool-result",
          output: new RegExp(GUARDED_ECHO_TOKEN),
          toolName: "guarded-echo",
        },
        status: "completed",
      },
      count: 1,
    });
    approved.event("session.waiting", { count: 1 });

    t.succeeded();
    t.calledTool("guarded-echo", { status: "completed", count: 1 });
  },
});
