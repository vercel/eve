import { defineEval } from "eve/evals";

import { GUARDED_ECHO_TOKEN } from "./shared";

/**
 * HITL flow: a plain follow-up message whose text matches an approval option
 * resolves the pending approval the same way as structured inputResponses.
 */
export default defineEval({
  description: "HITL smoke: text approve resolves a pending tool approval.",
  async test(t) {
    const parked = await t.send('Call the guarded-echo tool with note "text-approve".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    t.requireInputRequest({ display: "confirmation", toolName: "guarded-echo" });

    const approved = await t.send("approve");
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

    t.succeeded();
    t.calledTool("guarded-echo", {
      output: new RegExp(GUARDED_ECHO_TOKEN),
      status: "completed",
      count: 1,
    });
  },
});
