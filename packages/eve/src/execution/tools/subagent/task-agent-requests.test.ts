import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyTaskAgentRequest } from "#execution/tools/subagent/task-agent-requests.js";
import {
  dispatchTaskAgentInvocationStep,
  settleTaskAgentInvocationStep,
} from "#execution/tools/subagent/invoke-step.js";
import { emitTaskSubagentCalledStep } from "#execution/tools/subagent/emit-called-step.js";
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
  it("reuses the settlement step's flushed trace context during workflow replay", async () => {
    const serializedContext = { "eve.test": "before" };
    const flushedContext = { "eve.test": "after" };
    vi.mocked(settleTaskAgentInvocationStep).mockResolvedValue({
      serializedContext: flushedContext,
      sessionState,
    });
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
      serializedContext,
      sessionState,
      taskId: undefined,
    });
    expect(settled.serializedContext).toBe(flushedContext);
    const replay = await applyTaskAgentRequest(delivery, context);
    expect(replay).toEqual(settled);
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
