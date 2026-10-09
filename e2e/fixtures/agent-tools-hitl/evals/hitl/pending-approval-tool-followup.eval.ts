import { defineEval, type EveEvalEventMatch } from "eve/evals";
import { equals } from "eve/evals/expect";
import { requestFrom } from "./continuation/helpers.ts";

const MARKER = "draft-status-3494";
const READ_STATUS =
  `Alice is checking her draft. Call the read-draft-status tool exactly once with marker "${MARKER}". ` +
  "After the tool returns, tell Alice the status and marker from its result.";

/** The order a completed status read ends `turnId` in: its call, then a reply naming the status. */
function statusReadOrder(turnId: string, callId: string): EveEvalEventMatch[] {
  return [
    { type: "call.settled", data: { callId, outcome: "completed" }, scope: { turnId }, count: 1 },
    {
      type: "content.completed",
      data: {
        kind: "text",
        phase: "reply",
        value: (text) =>
          typeof text === "string" && text.includes(MARKER) && text.includes("ready"),
      },
      scope: { turnId },
      count: 1,
    },
    { type: "turn.settled", data: { turnId, outcome: "completed" }, count: 1 },
  ];
}

export default [
  defineEval({
    description:
      "An ungated status tool completes and produces a reply without a pending approval.",
    tags: ["hitl", "continuation", "control", "user-message", "tool-result"],
    timeoutMs: 120_000,
    async test(t) {
      // Given a fresh session with no pending approval.
      // When the user asks to read the draft status.
      const session = await t.session();
      const live = await session.start(READ_STATUS);
      const received = await live.waitForEvent("delivery.consumed");
      const turn = await live.result();

      // Then the tool executes once and the completed reply includes its status and marker.
      turn.expectOk();
      turn.calledTool("read-draft-status", { status: "completed", count: 1 });
      turn.event("turn.settled", { count: 1, data: { outcome: "completed" } });
      turn.messageIncludes(MARKER);
      turn.messageIncludes("ready");
      const read = turn.toolCalls.find((call) => call.name === "read-draft-status");
      if (read === undefined) throw new Error("Expected the status read.");
      const { turnId } = received.data;
      turn.eventOrder([
        { type: "delivery.consumed", data: { turnId }, count: 1 },
        ...statusReadOrder(turnId, read.callId),
      ]);
    },
  }),
  defineEval({
    description:
      "An ungated tool follow-up steers a held approval, cancels it, and completes (#3494).",
    tags: ["hitl", "continuation", "regression", "user-message", "tool-result"],
    timeoutMs: 120_000,
    async test(t) {
      // Given an account change is waiting for approval.
      const parked = await t.send(
        'Alice is preparing an account change. Call the gate tool exactly once with marker "account-change-3494".',
      );
      const session = parked.session;
      parked.calledTool("gate", { status: "pending", count: 1 });
      parked.notEvent("call.settled");
      const approval = requestFrom(parked, "gate");
      t.log(`Original gate approval is pending: ${approval.requestId}`);

      // When the user moves on and asks to read the draft status instead. The
      // approval holds the turn, so this message steers it.
      const live = await session.start(
        `Alice will review the account change later. ${READ_STATUS}`,
      );
      // Then the tool result reaches a completed reply without executing the account change.
      const result = await live.waitForToolCall("read-draft-status", { status: "completed" });
      t.log(`Follow-up tool completed before waiting for its reply: ${JSON.stringify(result)}`);
      const received = await live.waitForEvent("delivery.consumed");
      const { turnId } = received.data;
      await live.waitForEvent("turn.settled", { data: { turnId } });
      const followup = await live.result();
      followup.expectOk();
      followup.calledTool("read-draft-status", { status: "completed", count: 1 });
      followup.messageIncludes(MARKER);
      followup.messageIncludes("ready");
      followup.eventOrder([
        // The follow-up joins the held turn instead of starting one.
        { type: "delivery.consumed", data: { turnId }, count: 1 },
        ...statusReadOrder(turnId, result.callId),
      ]);
      followup.calledTool("gate", { status: "completed", count: 0 });
      followup.notEvent("interaction.opened");
      // Then the steer cancelled the account change instead of leaving it open.
      followup.event("interaction.settled", {
        count: 1,
        data: { interactionId: approval.requestId, outcome: "withdrawn" },
      });
      t.check(session.pendingInputRequests.length, equals(0));
    },
  }),
];
