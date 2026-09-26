import { describe, expect, it } from "vitest";
import { defaultMessageReducer } from "#client/message-reducer.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";
import { TerminalMessageProjection } from "./message-projection.js";

describe("terminal message projection", () => {
  it("keeps later block identities when a null completion removes an earlier streamed run", () => {
    const reducer = defaultMessageReducer();
    const terminal = new TerminalMessageProjection();
    let data = reducer.initial();
    const events = [
      {
        type: "message.appended",
        data: { turnId: "t0", sequence: 0, stepIndex: 0, messageDelta: "marker" },
      },
      {
        type: "message.appended",
        data: { turnId: "t0", sequence: 0, stepIndex: 1, messageDelta: "answer" },
      },
      {
        type: "message.completed",
        data: { turnId: "t0", sequence: 0, stepIndex: 0, message: null, finishReason: "stop" },
      },
      {
        type: "message.completed",
        data: { turnId: "t0", sequence: 0, stepIndex: 1, message: "answer", finishReason: "stop" },
      },
    ] as EveAgentReducerEvent[];
    const updates = events.flatMap((event) => {
      data = reducer.reduce(data, event);
      return [...terminal.transition(data)];
    });
    expect(updates).toEqual([
      { type: "assistant-delta", id: "text:t0:0", delta: "marker" },
      { type: "assistant-delta", id: "text:t0:1", delta: "answer" },
      { type: "assistant-remove", id: "text:t0:0" },
      { type: "assistant-complete", id: "text:t0:1" },
    ]);
  });

  it("closes unfinished blocks when the event source ends without a turn boundary", () => {
    const reducer = defaultMessageReducer();
    const terminal = new TerminalMessageProjection();
    const data = reducer.reduce(reducer.initial(), {
      type: "message.appended",
      data: { turnId: "t0", sequence: 0, stepIndex: 0, messageDelta: "partial" },
    } as EveAgentReducerEvent);
    expect([...terminal.transition(data)]).toEqual([
      { type: "assistant-delta", id: "text:t0:0", delta: "partial" },
    ]);
    expect([...terminal.finish()]).toEqual([{ type: "assistant-complete", id: "text:t0:0" }]);
  });

  it("shares approval, partial output, and terminal result transitions with chat", () => {
    const reducer = defaultMessageReducer();
    const terminal = new TerminalMessageProjection();
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
      return [...terminal.toolTransitions(data)];
    });
    expect(updates).toEqual([
      { type: "tool-call", toolCallId: "call", toolName: "color", input: {} },
      { type: "tool-approval-request", toolCallId: "call", approvalId: "approval" },
      { type: "tool-result", toolCallId: "call", output: "blue" },
    ]);
  });
});
