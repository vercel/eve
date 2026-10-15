import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { toFailedOutcome } from "#execution/tools/workflow/body.js";
import {
  workflowToolRunFailureOutput,
  workflowToolRunOutcomeToToolResult,
  workflowToolRunRequestToInputRequestPayload,
} from "#execution/tools/workflow/owner-inbox.js";
import type { InstrumentationEvent } from "#instrumentation/lifecycle.js";
import { createInstrumentationHandleEvent } from "#instrumentation/native-events.js";
import { createActionResultEvent, createActionsRequestedEvent } from "#protocol/message.js";

const from = {
  callId: "call-1",
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

  it("keeps the producer identity when forwarding a child request", () => {
    const request = {
      action: { callId: "child-call", input: {}, kind: "tool-call" as const, toolName: "ask" },
      kind: "question" as const,
      prompt: "What is Alice's answer?",
      requestId: "alice-ask",
    };
    expect(
      workflowToolRunRequestToInputRequestPayload({
        from,
        inputSource: "child:alice",
        replyTo: "child-inbox",
        request,
      }),
    ).toMatchObject({ inputSource: "child:alice", event: { requests: [request] } });
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

// https://github.com/vercel/eve/issues/4820
describe("a workflow body's failure", () => {
  async function toolCallFailed(error: Error): Promise<InstrumentationEvent | undefined> {
    const result = workflowToolRunOutcomeToToolResult({
      from,
      result: toFailedOutcome(error, new AbortController().signal),
    });
    const events: InstrumentationEvent[] = [];
    const handleEvent = createInstrumentationHandleEvent({
      getAttemptScope: () => ({
        attemptId: "session-1:turn-1:0:0",
        attemptIndex: 0,
        sessionId: "session-1",
        stepIndex: 0,
        turnId: "turn-1",
      }),
      handleEvent: async () => {},
      hooks: { capturesContent: true, publish: async (event) => void events.push(event) },
      sessionId: "session-1",
    })!;
    await contextStorage.run(new ContextContainer(), async () => {
      await handleEvent(
        createActionsRequestedEvent({
          actions: [{ callId: from.callId, input: {}, kind: "tool-call", toolName: from.toolName }],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-1",
        }),
      );
      await handleEvent(
        createActionResultEvent({ result, sequence: 0, stepIndex: 0, turnId: "turn-1" }),
      );
    });
    return events.find((event) => event.type === "tool.call.failed");
  }

  it("keeps the name of the error the body threw on tool.call.failed", async () => {
    const failed = await toolCallFailed(
      Object.assign(new Error("quota exceeded"), { name: "QuotaError" }),
    );

    expect(failed).toHaveProperty("error.name", "QuotaError");
    expect(failed).toHaveProperty("error.message", "quota exceeded");
  });

  it("keeps the name of a coded error the body threw on tool.call.failed", async () => {
    const failed = await toolCallFailed(
      Object.assign(new Error("quota exceeded"), { code: "QUOTA", name: "QuotaError" }),
    );

    expect(failed).toHaveProperty("error.name", "QuotaError");
    expect(failed).toHaveProperty("errorCode", "QUOTA");
  });
});
