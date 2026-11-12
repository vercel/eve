import { defineEval } from "eve/evals";

const MARKER = "authorized-response-oauth-nonblocking-K3T9";
const TOOL_NAME = "oauth-authorized-gate";
const REQUESTER = "oauth-nonblocking-requester";
const RESPONDER = "oauth-nonblocking-responder";
const BYSTANDER = "oauth-nonblocking-bystander";
const as = (principalId: string) => ({ headers: { "x-eve-fixture-user": principalId } });

export default defineEval({
  tags: ["real-model"],
  description:
    "Carol's message joins the turn while the responder's OAuth holds it, and OAuth then settles the approval as the responder, not the latest speaker.",
  async test(t) {
    const { session: conversation } = await t.send(
      `Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`,
      as(REQUESTER),
    );
    const approval = conversation.requireInteraction({
      display: "confirmation",
      toolName: TOOL_NAME,
    });
    const approvalTurn = await conversation.startRespond(
      [{ optionId: "approve", interactionId: approval.interactionId }],
      as(RESPONDER),
    );
    const required = await approvalTurn.waitForEvent("interaction.opened", {
      data: { request: { kind: "sign-in" } },
    });
    // The responder's sign-in holds the turn, so this read stops there.
    const held = await approvalTurn.result();

    // Someone other than the requester speaks while the sign-in is open: the message joins the
    // held turn, which replies and keeps waiting on the sign-in.
    const joined = await held.session.send(
      "Do not call tools. Reply with exactly CANDIDATE-OAUTH-OPEN-OK.",
      as(BYSTANDER),
    );
    joined.expectOk();
    joined.notEvent("turn.started");
    joined.messageIncludes("CANDIDATE-OAUTH-OPEN-OK");
    joined.notEvent("interaction.settled", {
      data: { interactionId: required.data.interactionId },
    });
    joined.notEvent("interaction.settled", { data: { interactionId: approval.interactionId } });
    joined.calledTool(TOOL_NAME, { status: "completed", count: 0 });
    const resumeIndex = joined.session.state.streamIndex;

    const url = required.data.request.signIn?.url;
    if (url === undefined) throw new Error("Expected candidate OAuth URL.");
    const audience = required.data.audience?.principalIds ?? [];
    if (audience.length !== 1 || audience[0] !== RESPONDER) {
      throw new Error(`Candidate sign-in named ${audience.join(", ")}, not the responder.`);
    }
    if (!("responseId" in required.data.subject)) {
      throw new Error("Expected the sign-in to be for the responder's answer.");
    }
    const callbackUrl = new URL(url);
    const callbackTurn = t.target.attach(held.sessionId, { startIndex: resumeIndex }).watch();
    const callback = await t.target.fetch(`${callbackUrl.pathname}${callbackUrl.search}`);
    if (!callback.ok)
      throw new Error(`Fixture OAuth callback failed (${String(callback.status)}).`);
    const resumed = await callbackTurn.result();
    resumed.event("interaction.settled", {
      count: 1,
      data: { interactionId: required.data.interactionId, outcome: "accepted" },
    });
    resumed.event("interaction.settled", {
      count: 1,
      data: { interactionId: approval.interactionId, outcome: "accepted" },
    });
    resumed.calledTool(TOOL_NAME, { output: new RegExp(MARKER), status: "completed", count: 1 });
    resumed.event("turn.settled", { count: 1, data: { outcome: "completed" } });
    t.succeeded();
  },
});
