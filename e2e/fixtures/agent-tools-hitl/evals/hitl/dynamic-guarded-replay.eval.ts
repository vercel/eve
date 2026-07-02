import { defineEval } from "eve/evals";

const DYNAMIC_GUARDED_ECHO_TOKEN = "dynamic-guarded-echo-ok-L8R6";
const TOOL_NAME = "dynamic_guarded_echo";

/**
 * HITL flow: a session-scoped dynamic tool's approval gate survives durable
 * replay. If replay drops `approval`, the tool executes immediately and
 * this eval fails before approval.
 */
export default defineEval({
  description: "HITL smoke: replayed dynamic tools preserve approval.",
  async test(t) {
    const parked = await t.send(`Call the \`${TOOL_NAME}\` tool with note "before-approval".`);
    t.requireInputRequest({
      display: "confirmation",
      toolName: TOOL_NAME,
    });
    parked.calledTool(TOOL_NAME, { status: "pending", count: 1 });

    const approved = await t.respondAll("approve");
    approved.expectOk();
    approved.event("action.result", {
      data: {
        result: {
          kind: "tool-result",
          toolName: TOOL_NAME,
          output: new RegExp(DYNAMIC_GUARDED_ECHO_TOKEN),
        },
        status: "completed",
      },
      count: 1,
    });

    t.succeeded();
    t.calledTool(TOOL_NAME, {
      output: new RegExp(DYNAMIC_GUARDED_ECHO_TOKEN),
      count: 1,
    });
  },
});
