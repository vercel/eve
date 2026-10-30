import { defineEval } from "eve/evals";

const MARKER = "authorized-response-e2e-Q7M4";
const TOOL_NAME = "authorized-gate";

export default defineEval({
  tags: ["real-model"],
  description: "Authenticated response policy emits candidate and settlement before execution.",
  async test(t) {
    const parked = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    const session = parked.session;
    const approval = session.requireInteraction({ display: "confirmation", toolName: TOOL_NAME });
    parked.calledTool(TOOL_NAME, { status: "pending", count: 1 });

    const approved = await session.respond([
      {
        optionId: "approve",
        interactionId: approval.interactionId,
      },
    ]);

    approved.expectOk();
    approved.event("response.submitted", {
      data: { interactionId: approval.interactionId },
      count: 1,
    });
    approved.event("interaction.settled", {
      data: { interactionId: approval.interactionId, outcome: "accepted" },
      count: 1,
    });
    approved.eventOrder([
      { type: "interaction.settled", data: { interactionId: approval.interactionId } },
      { type: "call.started", data: { clearedBy: { interactionId: approval.interactionId } } },
    ]);
    approved.calledTool(TOOL_NAME, { output: new RegExp(MARKER), status: "completed", count: 1 });
    t.succeeded();
  },
});
