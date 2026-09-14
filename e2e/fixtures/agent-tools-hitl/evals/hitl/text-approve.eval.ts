import { defineEval } from "eve/evals";

const MARKER = "authorized-response-retry-e2e-N4J8";
const TOOL_NAME = "responder-gate";

export default defineEval({
  tags: ["real-model"],
  description: "A rejected responder leaves the approval open for an authorized retry.",
  async test(t) {
    const parked = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    const approval = t.requireInputRequest({ display: "confirmation", toolName: TOOL_NAME });
    parked.calledTool(TOOL_NAME, { status: "pending", count: 1 });

    const rejectedTurn = await t.startRespond(
      [{ optionId: "approve", requestId: approval.requestId }],
      { headers: { "x-eve-fixture-user": "unauthorized-responder" } },
    );
    await rejectedTurn.waitForEvent("approval.candidate", {
      data: { outcome: "rejected", requestId: approval.requestId },
    });

    const approved = await rejectedTurn.session.respond([
      { optionId: "approve", requestId: approval.requestId },
    ]);
    approved.expectOk();
    approved.event("approval.settled", {
      count: 1,
      data: { outcome: "approved", requestId: approval.requestId },
    });
    approved.event("action.result", {
      count: 1,
      data: {
        result: { kind: "tool-result", output: new RegExp(MARKER), toolName: TOOL_NAME },
        status: "completed",
      },
    });
    t.succeeded();
  },
});
