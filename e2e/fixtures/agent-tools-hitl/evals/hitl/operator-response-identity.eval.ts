import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description: "Operator approval is audited separately from the suspended user's tool execution.",
  async test(t) {
    const parked = await t.send('Call `authorized-gate` with marker "operator-identity".');
    const request = t.requireInputRequest({ display: "confirmation", toolName: "authorized-gate" });
    const state = t.state;
    if (!state) throw new Error("Expected active client state");
    const resumed = t.target.watchTurn(parked.sessionId, { startIndex: state.streamIndex });
    const response = await t.target.fetch(
      `/eve/v1/session/${encodeURIComponent(parked.sessionId)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-eve-fixture-user": "e2e-approval-operator",
        },
        body: JSON.stringify({
          inputResponses: [{ requestId: request.requestId, optionId: "approve" }],
        }),
      },
    );
    if (!response.ok) throw new Error(`Approval failed: ${response.status}`);
    const result = await resumed.result();
    result.expectOk();
    result.event("approval.settled", {
      data: {
        requestId: request.requestId,
        outcome: "approved",
        responderPrincipalId: "e2e-approval-operator",
      },
      count: 1,
    });
    result.event("action.result", {
      data: {
        status: "completed",
        result: {
          kind: "tool-result",
          toolName: "authorized-gate",
          output: /"caller"\s*:\s*"e2e-approval-responder"/,
        },
      },
      count: 1,
    });
    t.succeeded();
  },
});
