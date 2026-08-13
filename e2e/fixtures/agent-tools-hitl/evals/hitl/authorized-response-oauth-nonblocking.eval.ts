import { defineEval } from "eve/evals";

const MARKER = "authorized-response-oauth-nonblocking-K3T9";
const TOOL_NAME = "oauth-authorized-gate";

export default defineEval({
  tags: ["real-model"],
  description: "A message runs while candidate OAuth stays open, then OAuth settles the approval.",
  async test(t) {
    const parked = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    const approval = t.requireInputRequest({ display: "confirmation", toolName: TOOL_NAME });
    const approvalTurn = await t.startRespond(
      [{ optionId: "approve", requestId: approval.requestId }],
      { headers: { "x-eve-fixture-user": "oauth-nonblocking-responder" } },
    );
    const required = await approvalTurn.waitForEvent("authorization.required");

    const message = await approvalTurn.session.send(
      "Do not call tools. Reply with exactly CANDIDATE-OAUTH-OPEN-OK.",
    );
    message.expectOk();
    message.messageIncludes("CANDIDATE-OAUTH-OPEN-OK");
    message.notEvent("approval.settled");
    message.notEvent("action.result", {
      data: { result: { kind: "tool-result", toolName: TOOL_NAME }, status: "completed" },
    });

    if (
      required.type !== "authorization.required" ||
      required.data.authorization?.url === undefined
    ) {
      throw new Error("Expected candidate OAuth URL.");
    }
    const callbackUrl = new URL(required.data.authorization.url);
    const callbackTurn = t.target.watchTurn(approvalTurn.sessionId, {
      startIndex: t.state?.streamIndex,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const callback = await fetch(callbackUrl);
    if (!callback.ok)
      throw new Error(`Fixture OAuth callback failed (${String(callback.status)}).`);
    const resumed = await callbackTurn.result();
    resumed.event("authorization.completed", { count: 1, data: { outcome: "authorized" } });
    resumed.event("approval.settled", {
      count: 1,
      data: { outcome: "approved", requestId: approval.requestId },
    });
    resumed.event("action.result", {
      count: 1,
      data: {
        result: { kind: "tool-result", output: new RegExp(MARKER), toolName: TOOL_NAME },
        status: "completed",
      },
    });
    t.succeeded();
  },
});
