import { defineEval } from "eve/evals";

const MARKER = "authorized-response-oauth-e2e-R8N5";
const TOOL_NAME = "oauth-authorized-gate";

export default defineEval({
  tags: ["real-model"],
  description: "Approval response policy parks for fake OAuth, resumes, and settles.",
  async test(t) {
    const parked = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    const approval = t.requireInputRequest({ display: "confirmation", toolName: TOOL_NAME });
    const approvalTurn = await t.startRespond([
      {
        optionId: "approve",
        requestId: approval.requestId,
      },
    ]);

    const required = await approvalTurn.waitForEvent("authorization.required");
    if (
      required?.type !== "authorization.required" ||
      required.data.authorization?.url === undefined
    ) {
      throw new Error("Expected a fake OAuth authorization URL.");
    }
    const callbackUrl = new URL(required.data.authorization.url);
    if (callbackUrl.origin !== new URL(t.target.url).origin) {
      throw new Error("Fixture OAuth callback targeted an unexpected origin.");
    }
    const callback = await fetch(callbackUrl);
    if (!callback.ok) {
      throw new Error(
        `Fixture OAuth callback failed (${String(callback.status)}): ${await callback.text()}`,
      );
    }

    const resumed = await approvalTurn.result();
    resumed.event("approval.candidate", {
      data: { outcome: "pending", requestId: approval.requestId },
      count: 1,
    });
    resumed.event("authorization.required", { count: 1 });
    resumed.expectOk();
    resumed.event("authorization.completed", {
      data: { candidateId: required.data.candidateId, outcome: "authorized" },
      count: 1,
    });
    resumed.event("approval.settled", {
      data: { outcome: "approved", requestId: approval.requestId },
      count: 1,
    });
    resumed.event("action.result", {
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
