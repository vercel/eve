import { describe, expect, it } from "vitest";
import { defaultMessageReducer } from "#client/message-reducer.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";
import { TerminalToolProjection } from "./message-projection.js";

describe("terminal tool projection", () => {
  it("shares approval, partial output, and terminal result transitions with chat", () => {
    const reducer = defaultMessageReducer();
    const terminal = new TerminalToolProjection();
    terminal.announceTool("call");
    let data = reducer.initial();
    const events = [
      {
        type: "actions.requested",
        data: {
          turnId: "t0",
          sequence: 0,
          stepIndex: 0,
          actions: [{ kind: "tool-call", callId: "call", toolName: "color", input: {} }],
        },
      },
      {
        type: "input.requested",
        data: {
          turnId: "t0",
          sequence: 0,
          stepIndex: 0,
          requests: [
            {
              kind: "tool-approval",
              requestId: "approval",
              prompt: "Approve?",
              display: "confirmation",
              options: [{ id: "approve", label: "Approve" }],
              action: { kind: "tool-call", callId: "call", toolName: "color", input: {} },
            },
          ],
        },
      },
      {
        type: "approval.settled",
        data: {
          requestId: "approval",
          outcome: "approved",
          sequence: 0,
          stepIndex: 0,
          turnId: "t0",
        },
      },
      {
        type: "action.partial",
        data: {
          result: { kind: "tool-result", callId: "call", toolName: "color", output: "draft" },
          sequence: 0,
          stepIndex: 0,
          turnId: "t0",
        },
      },
      {
        type: "action.result",
        data: {
          result: { kind: "tool-result", callId: "call", toolName: "color", output: "blue" },
          status: "completed",
          sequence: 0,
          stepIndex: 0,
          turnId: "t0",
        },
      },
    ] as EveAgentReducerEvent[];
    const updates = events.flatMap((event) => {
      data = reducer.reduce(data, event);
      return [...terminal.transitions(data)];
    });
    expect(updates).toEqual([
      { type: "tool-call", toolCallId: "call", toolName: "color", input: {} },
      { type: "tool-approval-request", toolCallId: "call", approvalId: "approval" },
      { type: "tool-result", toolCallId: "call", output: "blue" },
    ]);
  });
});
