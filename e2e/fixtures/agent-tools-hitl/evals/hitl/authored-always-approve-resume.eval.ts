import { defineEval } from "eve/evals";

const MARKER = "authored-always-approve-resume-N4K7";
const TOOL_NAME = "gate";

/** Regression reproduction for https://github.com/vercel/eve/issues/533. */
export default defineEval({
  description:
    "HITL repro (#533): a separate approval response executes an authored always-gated tool.",
  async test(t) {
    const parked = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    parked.calledTool(TOOL_NAME, { status: "pending", count: 1 });
    const approval = t.requireInputRequest({
      display: "confirmation",
      toolName: TOOL_NAME,
    });

    // This sends only `inputResponses` in a separate turn. No user message or
    // channel context follows the tool approval response in the model input.
    const approved = await t.respond({
      optionId: "approve",
      requestId: approval.requestId,
    });

    approved.expectOk();
    approved.event("action.result", {
      data: {
        result: {
          kind: "tool-result",
          output: new RegExp(MARKER),
          toolName: TOOL_NAME,
        },
        status: "completed",
      },
      count: 1,
    });
    t.succeeded();
  },
});
