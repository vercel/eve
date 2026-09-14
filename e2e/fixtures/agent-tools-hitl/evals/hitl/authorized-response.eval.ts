import { defineEval } from "eve/evals";

const MARKER = "authorized-response-e2e-Q7M4";
const TOOL_NAME = "authorized-gate";

export default defineEval({
  tags: ["real-model"],
  description: "Authenticated response policy emits candidate and settlement before execution.",
  async test(t) {
    const parked = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    const approval = t.requireInputRequest({ display: "confirmation", toolName: TOOL_NAME });
    parked.calledTool(TOOL_NAME, { status: "pending", count: 1 });

    const approved = await t.respond([
      {
        optionId: "approve",
        requestId: approval.requestId,
      },
    ]);

    approved.expectOk();
    approved.event("approval.candidate", {
      data: { outcome: "pending", requestId: approval.requestId },
      count: 1,
    });
    approved.event("approval.settled", {
      data: { outcome: "approved", requestId: approval.requestId },
      count: 1,
    });
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
