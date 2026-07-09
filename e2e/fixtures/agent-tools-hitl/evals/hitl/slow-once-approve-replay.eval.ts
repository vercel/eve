import { defineEval } from "eve/evals";

import { GUARDED_SLOW_ECHO_TOKEN } from "./shared.js";

const TOOL_NAME = "guarded-slow-echo";

/**
 * Regression coverage for https://github.com/vercel/eve/issues/460.
 *
 * A `once()`-gated tool with a slow async `execute` is called twice in one
 * user turn. The first call is human-approved, and the second auto-approves via
 * the session's `once()` grant. The approved call's `tool_result` reaches
 * durable history through the AI SDK's accumulated response messages. If eve
 * keeps only the final step response, the next turn replays a `tool_use`
 * without a `tool_result` and the provider rejects every later turn.
 */
export default defineEval({
  description: "HITL regression (#460): approved slow tool result survives replay.",
  async test(t) {
    const parked = await t.send(
      `Call the ${TOOL_NAME} tool with note "alpha". After its result arrives, call it again with note "beta". Use strictly one call at a time, never in parallel. When both results are in, reply with exactly SLOW-DONE.`,
    );
    parked.calledTool(TOOL_NAME, { status: "pending", count: 1 });
    const request = t.requireInputRequest({
      display: "confirmation",
      toolName: TOOL_NAME,
    });

    const approved = await t.respond({
      requestId: request.requestId,
      optionId: "approve",
    });
    approved.expectOk();

    t.calledTool(TOOL_NAME, {
      output: new RegExp(GUARDED_SLOW_ECHO_TOKEN),
      status: "completed",
      count: 2,
    });

    const followup = await t.send("Reply with exactly SLOW-REPLAY-OK.");
    followup.expectOk();
    followup.messageIncludes(/SLOW-REPLAY-OK/i);

    t.succeeded();
  },
});
