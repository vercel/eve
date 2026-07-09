import { defineEval } from "eve/evals";

const DYNAMIC_GUARDED_ECHO_TOKEN = "dynamic-guarded-echo-ok-L8R6";
const TOOL_NAME = "dynamic_guarded_echo";

/**
 * Regression coverage for https://github.com/vercel/eve/issues/533.
 *
 * An always-gated dynamic tool parks, the user approves, the tool executes,
 * and then the session must keep working. The follow-up turn replays the
 * durable transcript containing the approval-parked call's `tool_use`,
 * approval request/response parts, and result; on Anthropic that replay is
 * where the reported `tool_use ids were found without tool_result blocks`
 * 400 lands, turning `session.waiting` into a terminal `session.failed`.
 */
export default defineEval({
  description: "HITL regression (#533): a resolved approval park replays on the next turn.",
  async test(t) {
    const parked = await t.send(`Call the \`${TOOL_NAME}\` tool with note "replay-probe".`);
    parked.calledTool(TOOL_NAME, { status: "pending", count: 1 });
    t.requireInputRequest({
      display: "confirmation",
      toolName: TOOL_NAME,
    });

    const approved = await t.respondAll("approve");
    approved.expectOk();
    approved.event("action.result", {
      data: {
        result: {
          kind: "tool-result",
          output: new RegExp(DYNAMIC_GUARDED_ECHO_TOKEN),
          toolName: TOOL_NAME,
        },
        status: "completed",
      },
      count: 1,
    });

    const followup = await t.send("Reply with exactly DYNAMIC-REPLAY-OK.");
    followup.expectOk();
    followup.messageIncludes(/DYNAMIC-REPLAY-OK/i);

    t.succeeded();
  },
});
