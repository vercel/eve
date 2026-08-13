import { defineEval } from "eve/evals";

const MARKER = "authorized-response-oauth-cancel-P6W2";
const TOOL_NAME = "oauth-authorized-gate";

export default defineEval({
  tags: ["real-model"],
  description: "Cancel beats a candidate parked on OAuth and a late callback cannot execute.",
  async test(t) {
    const parked = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    const approval = t.requireInputRequest({ display: "confirmation", toolName: TOOL_NAME });
    const approvalTurn = await t.startRespond(
      [{ optionId: "approve", requestId: approval.requestId }],
      { headers: { "x-eve-fixture-user": "oauth-cancel-responder" } },
    );
    const required = await approvalTurn.waitForEvent("authorization.required");

    const cancelTurn = await approvalTurn.session.startRespond([
      { optionId: "cancel", requestId: approval.requestId },
    ]);
    await cancelTurn.waitForEvent("approval.settled", {
      data: { outcome: "cancelled", requestId: approval.requestId },
    });
    const cancelled = await cancelTurn.result();
    cancelled.event("approval.settled", {
      count: 1,
      data: { outcome: "cancelled", requestId: approval.requestId },
    });
    cancelled.notEvent("action.result", {
      data: { result: { kind: "tool-result", toolName: TOOL_NAME }, status: "completed" },
    });

    if (
      required.type !== "authorization.required" ||
      required.data.authorization?.url === undefined
    ) {
      throw new Error("Expected candidate OAuth URL.");
    }
    const callbackUrl = new URL(required.data.authorization.url);
    const callback = await fetch(callbackUrl);
    if (!callback.ok)
      throw new Error(`Late fixture OAuth callback failed (${String(callback.status)}).`);

    const late = await cancelTurn.session.send("Confirm the cancelled action did not execute.");
    late.notEvent("approval.settled", { data: { outcome: "approved" } });
    late.notEvent("action.result", {
      data: { result: { kind: "tool-result", toolName: TOOL_NAME }, status: "completed" },
    });
    t.succeeded();
  },
});
