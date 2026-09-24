import { describe, expect, it } from "vitest";

import {
  workflowToolRunFailureOutput,
  workflowToolRunRequestToInputRequestPayload,
} from "#execution/tools/workflow/owner-inbox.js";

const from = {
  callId: "call-1",
  input: { message: "Find it" },
  runId: "run-1",
  sequence: 0,
  stepIndex: 0,
  taskId: "research-abc234",
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
      workflowToolRunRequestToInputRequestPayload({
        from,
        replyTo: "subagent:parent:call-1",
        request,
      }),
    ).toMatchObject({
      childContinuationToken: "subagent:parent:call-1",
      event: {
        requests: [request],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      },
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
      workflowToolRunRequestToInputRequestPayload({
        from,
        replyTo: "subagent:parent:call-1",
        request,
        requestCoordinates: { sequence: 4, stepIndex: 2, turnId: "turn-child" },
      }),
    ).toMatchObject({
      childContinuationToken: "subagent:parent:call-1",
      event: {
        requests: [request],
        sequence: 4,
        stepIndex: 2,
        turnId: "turn-child",
      },
    });
  });

  it("does not normalize workflow agent requests as human input", () => {
    expect(() =>
      workflowToolRunRequestToInputRequestPayload({
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

describe("workflow-tool task outcomes", () => {
  it("keeps a structured workflow failure as task failure data", () => {
    expect(
      workflowToolRunFailureOutput({
        from,
        result: {
          error: {
            code: "SUBAGENT_EXECUTION_FAILED",
            message: "child crashed",
          },
          status: "failed",
        },
      }),
    ).toEqual({
      code: "SUBAGENT_EXECUTION_FAILED",
      message: "child crashed",
    });
  });

  it("keeps ordinary workflow-tool task failures as message strings", () => {
    expect(
      workflowToolRunFailureOutput({
        from,
        result: {
          error: {
            message: "export failed",
          },
          status: "failed",
        },
      }),
    ).toEqual("export failed");
  });
});
