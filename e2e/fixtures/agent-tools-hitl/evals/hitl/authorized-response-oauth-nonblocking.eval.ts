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
    const required = await approvalTurn.waitForEvent("authorization.required");
    // The responder's sign-in holds the turn, so this read stops there.
    const held = await approvalTurn.result();
    const resumeIndex = held.session.state.streamIndex;

    // Someone other than the requester speaks while the sign-in is open: the
    // message waits for the held turn instead of steering it.
    const queued = await held.session.start(
      "Do not call tools. Reply with exactly CANDIDATE-OAUTH-OPEN-OK.",
      as(BYSTANDER),
    );

    if (
      required.type !== "authorization.required" ||
      required.data.authorization?.url === undefined
    ) {
      throw new Error("Expected candidate OAuth URL.");
    }
    if (required.data.principalId !== RESPONDER) {
      throw new Error(
        `Candidate sign-in named ${String(required.data.principalId)}, not the responder.`,
      );
    }
    const callbackUrl = new URL(required.data.authorization.url);
    const callbackTurn = t.target.watchTurn(held.sessionId, { startIndex: resumeIndex });
    const callback = await t.target.fetch(`${callbackUrl.pathname}${callbackUrl.search}`);
    if (!callback.ok)
      throw new Error(`Fixture OAuth callback failed (${String(callback.status)}).`);
    const resumed = await callbackTurn.result();
    resumed.event("authorization.completed", {
      count: 1,
      data: { outcome: "authorized", principalId: RESPONDER },
    });
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
    resumed.notEvent("message.received", { data: { message: /CANDIDATE-OAUTH-OPEN-OK/ } });

    const message = await queued.result();
    message.expectOk();
    message.messageIncludes("CANDIDATE-OAUTH-OPEN-OK");
    message.notEvent("action.result", {
      data: { result: { kind: "tool-result", toolName: TOOL_NAME }, status: "completed" },
    });
    t.succeeded();
  },
});
