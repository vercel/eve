import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyTaskAgentRequest } from "#execution/tools/subagent/task-agent-requests.js";
import {
  dispatchTaskAgentInvocationStep,
  settleTaskAgentInvocationStep,
} from "#execution/tools/subagent/invoke-step.js";
import { emitTaskSubagentCalledStep } from "#execution/tools/subagent/emit-called-step.js";
import { AGENT_TRACE_CONTEXT_KEY } from "#tracing/agent-trace-context-codec.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";

vi.mock("#execution/tools/subagent/invoke-step.js", () => ({
  dispatchTaskAgentInvocationStep: vi.fn(),
  settleTaskAgentInvocationStep: vi.fn(),
}));
vi.mock("#execution/tools/subagent/emit-called-step.js", () => ({
  emitTaskSubagentCalledStep: vi.fn(),
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: vi.fn(),
}));

const sessionState = { sessionId: "parent" } as never;
const result: RuntimeSubagentChildResult = {
  callId: "nested",
  kind: "subagent-result",
  origin: "child",
  outcome: {
    kind: "parked",
    result: { kind: "succeeded", output: "done" },
    usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 2, outputTokens: 3 },
  },
  output: "done",
  subagentName: "research",
};

beforeEach(() => vi.clearAllMocks());

describe("workflow-owned agent requests", () => {
  it("settles traces without adding anything to the durable settlement step contract", async () => {
    vi.mocked(settleTaskAgentInvocationStep).mockResolvedValue({ sessionState });
    const serializedContext = {
      [AGENT_TRACE_CONTEXT_KEY]: {
        invocations: {
          nested: {
            attemptIndex: 0,
            callId: "nested",
            kind: "subagent-call",
            name: "research",
            parent: { spanId: "1".repeat(16), traceFlags: 1, traceId: "2".repeat(32) },
            parentActionCallId: "outer",
            rootSessionId: "parent",
            sessionId: "parent",
            spanId: "3".repeat(16),
            startTimeMs: 1,
            stepIndex: 0,
            turnId: "turn-1",
          },
        },
      },
    };
    const delivery = {
      ownerId: "workflow-run",
      replyTo: "reply",
      request: { kind: "agent-settled" as const, result },
    };
    const context = { parentWritable: {} as never, serializedContext, sessionState };
    const settled = await applyTaskAgentRequest(delivery, context);

    expect(settleTaskAgentInvocationStep).toHaveBeenCalledWith({
      accumulateUsage: undefined,
      ownerId: "workflow-run",
      result,
      sessionState,
      taskId: undefined,
    });
    expect(settled.serializedContext).toMatchObject({
      [AGENT_TRACE_CONTEXT_KEY]: {
        invocations: {
          nested: {
            terminal: {
              outcome: "completed",
              usage: {
                inputTokens: 2,
                outputTokens: 3,
              },
            },
          },
        },
      },
    });
    const replay = await applyTaskAgentRequest(delivery, {
      ...context,
      serializedContext: settled.serializedContext,
    });
    expect(replay.serializedContext).toBe(settled.serializedContext);
  });

  it("retains existing context when replaying a dispatch result without tracing state", async () => {
    const serializedContext = { "eve.test": "preserved" };
    const event = { type: "subagent.called" } as never;
    vi.mocked(dispatchTaskAgentInvocationStep).mockResolvedValue({
      agentId: "child",
      event,
      kind: "dispatched",
      sessionState,
    });
    vi.mocked(emitTaskSubagentCalledStep).mockResolvedValue({ serializedContext });

    const applied = await applyTaskAgentRequest(
      {
        ownerId: "workflow-run",
        replyTo: "reply",
        request: {
          input: { message: "Find it", target: "research" },
          invocationId: "nested",
          kind: "agent-invoke",
        },
      },
      { parentWritable: {} as never, serializedContext, sessionState },
    );

    expect(emitTaskSubagentCalledStep).toHaveBeenCalledWith({
      event,
      parentWritable: {},
      serializedContext,
    });
    expect(applied.serializedContext).toBe(serializedContext);
  });
});
