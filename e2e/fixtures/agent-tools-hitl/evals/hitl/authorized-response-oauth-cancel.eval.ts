import { defineEval } from "eve/evals";

const MARKER = "authorized-response-oauth-cancel-P6W2";
const TOOL_NAME = "oauth-authorized-gate";

export default defineEval({
  tags: ["real-model"],
  description: "Cancel beats a candidate parked on OAuth and a late callback cannot execute.",
  async test(t) {
    const { session: conversation } = await t.send(
      `Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`,
    );
    const approval = conversation.requireInteraction({
      display: "confirmation",
      toolName: TOOL_NAME,
    });
    const approvalTurn = await conversation.startRespond(
      [{ optionId: "approve", interactionId: approval.interactionId }],
      { headers: { "x-eve-fixture-user": "oauth-cancel-responder" } },
    );
    const required = await approvalTurn.waitForEvent("interaction.opened", {
      data: { request: { kind: "sign-in" } },
    });
    // The responder's sign-in holds the turn, so this read stops there.
    const held = await approvalTurn.result();

    const cancelled = await held.session.respond([
      { optionId: "deny", interactionId: approval.interactionId },
    ]);
    cancelled.event("interaction.settled", {
      count: 1,
      data: { interactionId: approval.interactionId, outcome: "declined" },
    });
    cancelled.calledTool(TOOL_NAME, { status: "completed", count: 0 });

    const url = required.data.request.signIn?.url;
    if (url === undefined) throw new Error("Expected candidate OAuth URL.");
    const callbackUrl = new URL(url);
    const callback = await t.target.fetch(`${callbackUrl.pathname}${callbackUrl.search}`);
    if (!callback.ok)
      throw new Error(`Late fixture OAuth callback failed (${String(callback.status)}).`);

    const late = await cancelled.session.send("Confirm the cancelled action did not execute.");
    late.notEvent("interaction.settled", {
      data: { interactionId: approval.interactionId, outcome: "accepted" },
    });
    late.calledTool(TOOL_NAME, { status: "completed", count: 0 });
    t.succeeded();
  },
});
