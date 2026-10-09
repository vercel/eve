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
    "Carol's message waits while the responder's OAuth holds the turn, then OAuth settles the approval as the responder, not the latest speaker, and Carol's message runs.",
  async test(t) {
    const { session: conversation } = await t.send(
      `Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`,
      as(REQUESTER),
    );
    const approval = conversation.requireInputRequest({
      display: "confirmation",
      toolName: TOOL_NAME,
    });
    const approvalTurn = await conversation.startRespond(
      [{ optionId: "approve", requestId: approval.requestId }],
      as(RESPONDER),
    );
    const required = await approvalTurn.waitForEvent("interaction.opened", {
      data: { request: { kind: "sign-in" } },
    });
    // The responder's sign-in holds the turn, so this read stops there.
    const held = await approvalTurn.result();
    const resumeIndex = held.session.state.streamIndex;

    // Someone other than the requester speaks while the sign-in is open: the
    // message waits for the held turn instead of steering it.
    const queued = await held.session.start(
      "Do not call tools. Reply with exactly CANDIDATE-OAUTH-OPEN-OK.",
      as(BYSTANDER),
    );

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
    const callbackTurn = t.target.watchTurn(held.sessionId, { startIndex: resumeIndex });
    const callback = await fetch(callbackUrl);
    if (!callback.ok)
      throw new Error(`Fixture OAuth callback failed (${String(callback.status)}).`);
    const resumed = await callbackTurn.result();
    resumed.event("interaction.settled", {
      count: 1,
      data: { interactionId: required.data.interactionId, outcome: "accepted" },
    });
    resumed.event("interaction.settled", {
      count: 1,
      data: { interactionId: approval.requestId, outcome: "accepted" },
    });
    resumed.calledTool(TOOL_NAME, { output: new RegExp(MARKER), status: "completed", count: 1 });
    resumed.notEvent("delivery.consumed", {
      data: { parts: [{ text: /CANDIDATE-OAUTH-OPEN-OK/ }] },
    });

    const message = await queued.result();
    message.expectOk();
    message.messageIncludes("CANDIDATE-OAUTH-OPEN-OK");
    message.calledTool(TOOL_NAME, { status: "completed", count: 0 });
    t.succeeded();
  },
});
