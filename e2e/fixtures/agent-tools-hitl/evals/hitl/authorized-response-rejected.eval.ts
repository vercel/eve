import { defineEval } from "eve/evals";

const MARKER = "authorized-response-rejected-e2e-M2K6";
const TOOL_NAME = "responder-gate";

export default defineEval({
  tags: ["real-model"],
  metadata: {
    transitions: ["owner.approval.candidate.reject", "owner.approval.response.reject-unauthorized"],
  },
  description:
    "A rejected responder candidate leaves the shared approval open for another responder.",
  async test(t) {
    const _parked = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    const approval = t.requireInputRequest({ display: "confirmation", toolName: TOOL_NAME });

    const rejected = await t.respond([{ optionId: "approve", requestId: approval.requestId }], {
      headers: { "x-eve-fixture-user": "unauthorized-responder" },
    });
    rejected.expectOk();
    rejected.event("approval.candidate", {
      count: 1,
      data: { outcome: "rejected", requestId: approval.requestId },
    });
    rejected.notEvent("approval.settled");
    rejected.notEvent("action.result", {
      data: { result: { kind: "tool-result", toolName: TOOL_NAME }, status: "completed" },
    });

    const reopened = t.requireInputRequest({
      display: "confirmation",
      toolName: TOOL_NAME,
    });
    if (reopened.requestId !== approval.requestId) {
      throw new Error("A rejected candidate replaced the still-open approval.");
    }

    const approved = await t.respond([{ optionId: "approve", requestId: approval.requestId }]);
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
