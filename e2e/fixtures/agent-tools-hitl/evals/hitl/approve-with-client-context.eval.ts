import { defineEval } from "eve/evals";

import { GUARDED_ECHO_TOKEN } from "./shared.js";

/**
 * Red e2e for https://github.com/vercel/eve/issues/529.
 *
 * Approving a pending tool call with `clientContext` on the same send is the
 * channel-agnostic form of the Linear channel's per-prompt context. The
 * harness appends the context user messages after the approval-response tool
 * message, so the AI SDK's last-message approval scan finds nothing to
 * execute, the approved `tool_use` is persisted without a `tool_result`, and
 * the provider rejects the request. Expected once fixed: the context must not
 * prevent the approved tool from executing.
 */
export default defineEval({
  description: "HITL red (#529): approval answered with channel context still executes the tool.",
  async test(t) {
    const parked = await t.send('Call the guarded-echo tool with note "context-approve".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({
      display: "confirmation",
      toolName: "guarded-echo",
    });

    const approved = await t.send({
      inputResponses: [{ requestId: request.requestId, optionId: "approve" }],
      clientContext:
        "<channel_context>Delegated issue ENG-123. The user answered the pending approval from the channel UI.</channel_context>",
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

    t.succeeded();
    t.calledTool("guarded-echo", {
      output: new RegExp(GUARDED_ECHO_TOKEN),
      status: "completed",
      count: 1,
    });
  },
});
