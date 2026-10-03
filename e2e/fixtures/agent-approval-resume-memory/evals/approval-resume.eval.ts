import { defineEval } from "eve/evals";

const MARKER = "approval-resume-memory-N7Q4";
const TOOL_NAME = "guarded-echo";

export default defineEval({
  description: "An approved tool executes when memory and user instructions run on resume.",
  async test(t) {
    const parked = await t.send(`Call ${TOOL_NAME} exactly once with marker "${MARKER}".`);
    parked.calledTool(TOOL_NAME, { count: 1, status: "pending" });
    const approval = parked.session.requireInputRequest({
      display: "confirmation",
      toolName: TOOL_NAME,
    });

    const approved = await parked.session.respond([
      { optionId: "approve", requestId: approval.requestId },
    ]);

    approved.expectOk();
    approved.calledTool(TOOL_NAME, { count: 1, status: "completed" });
    approved.messageIncludes("APPROVAL-RESUME-OK");
    approved.messageIncludes(MARKER);
    t.succeeded();
  },
});
