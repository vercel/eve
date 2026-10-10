import { defineEval } from "eve/evals";

const MARKER = "authorized-response-retry-e2e-N4J8";
const TOOL_NAME = "responder-gate";

export default defineEval({
  tags: ["real-model"],
  description: "A rejected responder leaves the approval open for an authorized retry.",
  async test(t) {
    const parked = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    const conversation = parked.session;
    const approval = conversation.requireInputRequest({
      display: "confirmation",
      toolName: TOOL_NAME,
    });
    parked.calledTool(TOOL_NAME, { status: "pending", count: 1 });

    const rejectedTurn = await conversation.startRespond(
      [{ optionId: "approve", requestId: approval.requestId }],
      { headers: { "x-eve-fixture-user": "unauthorized-responder" } },
    );
    await rejectedTurn.waitForEvent("response.settled", { data: { outcome: "refused" } });

    // Finish consuming the refusal boundary before opening the next response reader.
    (await rejectedTurn.result()).expectOk();
    const approved = await rejectedTurn.session.respond(
      [{ optionId: "approve", requestId: approval.requestId }],
      { headers: { "x-eve-fixture-user": "e2e-approval-responder" } },
    );
    approved.expectOk();
    approved.event("interaction.settled", {
      count: 1,
      data: { interactionId: approval.requestId, outcome: "accepted" },
    });
    approved.calledTool(TOOL_NAME, { output: new RegExp(MARKER), status: "completed", count: 1 });
    t.succeeded();
  },
});
