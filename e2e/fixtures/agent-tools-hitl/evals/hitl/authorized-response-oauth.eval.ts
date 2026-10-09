import { defineEval } from "eve/evals";

const MARKER = "authorized-response-oauth-e2e-R8N5";
const TOOL_NAME = "oauth-authorized-gate";

export default defineEval({
  tags: ["real-model"],
  description: "Approval response policy parks for fake OAuth, resumes, and settles.",
  async test(t) {
    const { session } = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    const approval = session.requireInputRequest({ display: "confirmation", toolName: TOOL_NAME });
    const approvalTurn = await session.startRespond([
      {
        optionId: "approve",
        requestId: approval.requestId,
      },
    ]);

    const required = await approvalTurn.waitForEvent("interaction.opened", {
      data: { request: { kind: "sign-in" } },
    });
    const url = required.data.request.signIn?.url;
    if (url === undefined) throw new Error("Expected a fake OAuth authorization URL.");
    const callbackUrl = new URL(url);
    if (callbackUrl.origin !== new URL(t.target.url).origin) {
      throw new Error("Fixture OAuth callback targeted an unexpected origin.");
    }
    // The responder's sign-in holds the turn, so this read stops there; the
    // callback resumes the same turn.
    const held = await approvalTurn.result();
    held.event("response.submitted", { data: { interactionId: approval.requestId }, count: 1 });
    held.event("interaction.opened", { data: { request: { kind: "sign-in" } }, count: 1 });
    held.notEvent("interaction.settled", { data: { interactionId: approval.requestId } });
    held.notEvent("turn.settled");
    const resumedTurn = t.target.watchTurn(held.sessionId, {
      startIndex: held.session.state.streamIndex,
    });
    const callback = await fetch(callbackUrl);
    if (!callback.ok) {
      throw new Error(
        `Fixture OAuth callback failed (${String(callback.status)}): ${await callback.text()}`,
      );
    }

    const resumed = await resumedTurn.result();
    resumed.expectOk();
    resumed.event("interaction.settled", {
      data: { interactionId: required.data.interactionId, outcome: "accepted" },
      count: 1,
    });
    resumed.event("interaction.settled", {
      data: { interactionId: approval.requestId, outcome: "accepted" },
      count: 1,
    });
    resumed.calledTool(TOOL_NAME, { output: new RegExp(MARKER), status: "completed", count: 1 });
    t.succeeded();
  },
});
