import { defineEval } from "eve/evals";

import { GUARDED_ECHO_TOKEN } from "./shared";

/**
 * HITL flow: unrelated text sent while an approval is pending must not deny
 * the approval or disappear. The message is replayed after the approval
 * receives an explicit terminal answer.
 */
export default defineEval({
  description: "HITL smoke: unrelated message during approval is queued.",
  async test(t) {
    const parked = await t.send('Call the guarded-echo tool with note "queued-approval".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({
      display: "confirmation",
      toolName: "guarded-echo",
    });

    const queued = await t.send(
      "After the pending approval is resolved, reply with exactly QUEUED-HITL-OK.",
    );
    queued.expectOk();
    queued.notEvent("action.result", {
      data: { result: { toolName: "guarded-echo" }, status: "rejected" },
    });
    queued.event("session.waiting", { count: 1 });

    const approved = await t.respond({
      requestId: request.requestId,
      optionId: "approve",
    });
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
    approved.messageIncludes(/QUEUED-HITL-OK/i);

    t.succeeded();
  },
});
