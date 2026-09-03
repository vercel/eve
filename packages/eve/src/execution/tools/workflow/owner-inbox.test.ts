import { describe, expect, it } from "vitest";

import {
  workflowToolRunOutcomeToTaskCommand,
  workflowToolRunReportToTaskPayload,
  workflowToolRunRequestToTaskInputRequest,
} from "#execution/tools/workflow/owner-inbox.js";

const from = {
  callId: "call-1",
  execution: "background" as const,
  input: { message: "Find it" },
  runId: "run-1",
  sequence: 0,
  stepIndex: 0,
  toolName: "research",
  turnId: "turn-1",
};

describe("workflow-tool task input", () => {
  it("preserves a forwarded child request id independently of its session route", () => {
    const request = {
      action: {
        callId: "child-call",
        input: { ticker: "GOOG" },
        kind: "tool-call" as const,
        toolName: "get_stock_price",
      },
      kind: "tool-approval" as const,
      prompt: "Approve tool call: get_stock_price",
      requestId: "approval-1",
    };

    expect(
      workflowToolRunRequestToTaskInputRequest({
        from,
        replyTo: "subagent:parent:call-1",
        request,
      }),
    ).toEqual({
      kind: "task-input-request",
      replyTo: "subagent:parent:call-1",
      request,
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-1",
    });
  });

  it("uses child event coordinates for repeated forwarded requests", () => {
    const request = {
      action: {
        callId: "child-call",
        input: {},
        kind: "tool-call" as const,
        toolName: "approval_gate",
      },
      kind: "tool-approval" as const,
      prompt: "Approve?",
      requestId: "approval-2",
    };

    expect(
      workflowToolRunRequestToTaskInputRequest({
        from,
        replyTo: "subagent:parent:call-1",
        request,
        requestCoordinates: { sequence: 4, stepIndex: 2, turnId: "turn-child" },
      }),
    ).toEqual({
      kind: "task-input-request",
      replyTo: "subagent:parent:call-1",
      request,
      sequence: 4,
      stepIndex: 2,
      turnId: "turn-child",
    });
  });

  it("does not normalize workflow agent requests as human input", () => {
    expect(() =>
      workflowToolRunRequestToTaskInputRequest({
        from,
        replyTo: "subagent:parent:call-1",
        request: {
          input: { message: "Find it", target: "research" },
          invocationId: "call-1",
          kind: "agent-invoke",
        },
      }),
    ).toThrow("A workflow agent request cannot be normalized as human input.");
  });
});

describe("workflow-tool task reports", () => {
  it("maps setState to durable task state without a parent message", () => {
    expect(
      workflowToolRunReportToTaskPayload(
        { from, update: { kind: "eve:task-set-state", state: { progress: 0.5 } } },
        "task-1",
        0,
      ),
    ).toEqual({
      command: { kind: "set-state", state: { progress: 0.5 } },
      kind: "task-command",
    });
  });

  it("maps postMessage to a distinct parent delivery", () => {
    expect(
      workflowToolRunReportToTaskPayload(
        { from, update: { kind: "eve:task-message", message: "Review this output." } },
        "task-1",
        2,
      ),
    ).toEqual({
      callId: "call-1",
      kind: "task-message",
      message: "Review this output.",
      messageEpoch: "task-1",
      messageIndex: 2,
    });
  });

  it("keeps untagged yields as progress", () => {
    expect(
      workflowToolRunReportToTaskPayload({ from, update: { progress: 0.5 } }, "task-1", 1),
    ).toEqual({
      callId: "call-1",
      kind: "task-update",
      message: '{"progress":0.5}',
      updateEpoch: "task-1",
      updateIndex: 1,
    });
  });
});

describe("workflow-tool task outcomes", () => {
  it("keeps a subagent failure object as task failure data", () => {
    expect(
      workflowToolRunOutcomeToTaskCommand({
        from: { ...from, resultKind: "subagent" },
        result: {
          error: {
            code: "SUBAGENT_EXECUTION_FAILED",
            message: "child crashed",
          },
          status: "failed",
        },
      }),
    ).toEqual({
      data: {
        code: "SUBAGENT_EXECUTION_FAILED",
        message: "child crashed",
      },
      kind: "fail",
    });
  });

  it("keeps ordinary workflow-tool task failures as message strings", () => {
    expect(
      workflowToolRunOutcomeToTaskCommand({
        from,
        result: {
          error: {
            message: "export failed",
          },
          status: "failed",
        },
      }),
    ).toEqual({
      data: "export failed",
      kind: "fail",
    });
  });
});
