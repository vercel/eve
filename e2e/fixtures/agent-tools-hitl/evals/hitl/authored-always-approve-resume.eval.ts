import { defineEval } from "eve/evals";

const MARKER = "authored-always-approve-resume-N4K7";
const TOOL_NAME = "gate";

/** Regression reproduction for https://github.com/vercel/eve/issues/533. */
export default defineEval({
  tags: ["real-model"],
  description:
    "HITL repro (#533): a separate approval response executes an authored always-gated tool.",
  async test(t) {
    const parked = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    const session = parked.session;
    parked.calledTool(TOOL_NAME, { status: "pending", count: 1 });
    const approval = session.requireInteraction({
      display: "confirmation",
      toolName: TOOL_NAME,
    });

    // This sends only `answers` in a separate turn. No user message or
    // channel context follows the tool approval response in the model input.
    const approved = await session.respond([
      {
        optionId: "approve",
        interactionId: approval.interactionId,
      },
    ]);

    approved.expectOk();
    approved.calledTool(TOOL_NAME, { output: new RegExp(MARKER), status: "completed", count: 1 });
    t.succeeded();
  },
});
