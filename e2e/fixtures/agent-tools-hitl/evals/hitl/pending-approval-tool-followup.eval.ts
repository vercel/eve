import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { requestFrom } from "./continuation/helpers.ts";

const MARKER = "draft-status-3494";
const READ_STATUS =
  `Alice is checking her draft. Call the read-status tool exactly once with marker "${MARKER}". ` +
  "After the tool returns, tell Alice the status and marker from its result.";

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
      const received = await live.waitForEvent("message.received");
      const turn = await live.result();

      // Then the tool executes once and the completed reply includes its status and marker.
      turn.expectOk();
      turn.calledTool("read-status", { status: "completed", count: 1 });
      turn.event("turn.completed", { count: 1 });
      turn.messageIncludes(MARKER);
      turn.messageIncludes("ready");
      turn.eventOrder([
        { type: "message.received", data: { turnId: received.data.turnId }, count: 1 },
        {
          type: "action.result",
          data: {
            turnId: received.data.turnId,
            status: "completed",
            result: { toolName: "read-status" },
          },
          count: 1,
        },
        {
          type: "message.completed",
          data: {
            turnId: received.data.turnId,
            message: (text) =>
              typeof text === "string" && text.includes(MARKER) && text.includes("ready"),
          },
          count: 1,
        },
        { type: "turn.completed", data: { turnId: received.data.turnId }, count: 1 },
      ]);
    },
  }),
  defineEval({
    description:
      "An ungated tool follow-up completes while an older approval remains answerable (#3494).",
    tags: ["hitl", "continuation", "regression", "user-message", "tool-result"],
    timeoutMs: 120_000,
    async test(t) {
      // Given an account change is waiting for approval.
      const parked = await t.send(
        'Alice is preparing an account change. Call the gate tool exactly once with marker "account-change-3494".',
      );
      const session = parked.session;
      parked.calledTool("gate", { status: "pending", count: 1 });
      parked.notEvent("action.result", { data: { result: { toolName: "gate" } } });
      const approval = requestFrom(parked, "gate");
      t.log(`Original gate approval is pending: ${approval.requestId}`);

      // When the user leaves that approval pending and asks to read the draft status.
      const live = await session.start(
        `Alice will review the account change later. Leave its approval pending. ${READ_STATUS}`,
      );
      // Then the tool result reaches a completed reply without executing the account change.
      const result = await live.waitForEvent("action.result", {
        data: { status: "completed", result: { toolName: "read-status" } },
      });
      t.log(`Follow-up tool completed before waiting for its reply: ${JSON.stringify(result)}`);
      const received = await live.waitForEvent("message.received");
      await live.waitForEvent("turn.completed", { data: { turnId: received.data.turnId } });
      const followup = await live.result();
      followup.expectOk();
      followup.calledTool("read-status", { status: "completed", count: 1 });
      followup.messageIncludes(MARKER);
      followup.messageIncludes("ready");
      followup.eventOrder([
        { type: "message.received", data: { turnId: received.data.turnId }, count: 1 },
        {
          type: "action.result",
          data: {
            turnId: received.data.turnId,
            status: "completed",
            result: { toolName: "read-status" },
          },
          count: 1,
        },
        {
          type: "message.completed",
          data: {
            turnId: received.data.turnId,
            message: (text) =>
              typeof text === "string" && text.includes(MARKER) && text.includes("ready"),
          },
          count: 1,
        },
        { type: "turn.completed", data: { turnId: received.data.turnId }, count: 1 },
      ]);
      followup.notEvent("action.result", { data: { result: { toolName: "gate" } } });
      followup.notEvent("input.requested");

      // When the user later approves the original account change.
      const approved = await session.respond([
        { requestId: approval.requestId, optionId: "approve" },
      ]);
      // Then that saved approval executes exactly once.
      approved.expectOk();
      approved.calledTool("gate", { status: "completed", count: 1 });
      session.event("action.result", {
        count: 1,
        data: { status: "completed", result: { toolName: "gate" } },
      });
      t.check(session.pendingInputRequests.length, equals(0));
    },
  }),
];
