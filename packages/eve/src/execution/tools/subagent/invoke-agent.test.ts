import { beforeEach, describe, expect, it, vi } from "vitest";

import { attachWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";
import { agent, type AgentInvocationReply } from "#execution/tools/subagent/invoke-agent.js";
import type { ToolContext } from "#tools/definition.js";

const mocks = vi.hoisted(() => ({
  claimHookOwnership: vi.fn(),
  createHook: vi.fn(),
  disposeHook: vi.fn(),
  resumeHook: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createHook: mocks.createHook,
}));
vi.mock("#execution/hook-ownership.js", () => ({
  claimHookOwnership: mocks.claimHookOwnership,
  disposeHook: mocks.disposeHook,
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: (...args: unknown[]) => mocks.resumeHook(...args),
}));
beforeEach(() => vi.resetAllMocks());

describe("background agent invocation routing", () => {
  it("stops waiting when the workflow body is cancelled", async () => {
    const controller = new AbortController();
    mocks.createHook.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      token: "agent-reply",
    });
    const ctx = { abortSignal: controller.signal, callId: "call-1" } as ToolContext;
    attachWorkflowToolRunContext(ctx, {
      admission: Promise.resolve({ status: "accepted" }),
      from: {
        callId: "call-1",
        execution: "background",
        input: { message: "Find it" },
        runId: "run-1",
        sequence: 0,
        stepIndex: 0,
        toolName: "research",
        turnId: "turn-1",
      },
      owner: {
        admission: "owner-admission",
        outcome: "owner-outcome",
        report: "owner-report",
        request: "owner-request",
      },
    });

    const result = agent(ctx, { key: "research", message: "Find it", target: "research" });
    await vi.waitFor(() => expect(mocks.resumeHook).toHaveBeenCalledOnce());
    controller.abort(new Error("task cancelled"));

    await expect(result).rejects.toThrow("task cancelled");
    expect(mocks.disposeHook).toHaveBeenCalledOnce();
  });

  it("sends the invocation through the task owner after admission", async () => {
    const result = {
      callId: "call-1:research",
      kind: "subagent-result" as const,
      origin: "child" as const,
      outcome: {
        kind: "parked" as const,
        result: { kind: "succeeded" as const, output: "available" },
        usageDelta: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      output: "available",
      subagentName: "research",
    };
    const replies: AgentInvocationReply[] = [{ kind: "runtime-action-result", results: [result] }];
    mocks.createHook.mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          replies.length > 0
            ? { done: false as const, value: replies.shift()! }
            : { done: true as const, value: undefined },
      }),
      token: "agent-reply",
    });
    mocks.resumeHook.mockImplementation(async () => undefined);
    const from: WorkflowToolRunRef = {
      callId: "call-1",
      execution: "background",
      input: { message: "Find it" },
      runId: "run-1",
      sequence: 0,
      stepIndex: 0,
      toolName: "research",
      turnId: "turn-1",
    };
    const ctx = { callId: "call-1" } as ToolContext;
    attachWorkflowToolRunContext(ctx, {
      admission: Promise.resolve({ status: "accepted" }),
      from,
      owner: {
        admission: "owner-admission",
        outcome: "owner-outcome",
        report: "owner-report",
        request: "owner-request",
      },
    });

    await expect(
      agent(ctx, { key: "research", message: "Find it", target: "research" }),
    ).resolves.toBe("available");

    expect(mocks.claimHookOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ token: "agent-reply" }),
    );
    expect(mocks.claimHookOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resumeHook.mock.invocationCallOrder[0]!,
    );
    expect(mocks.resumeHook).toHaveBeenCalledWith("owner-request", {
      from,
      replyTo: "agent-reply",
      request: {
        input: { message: "Find it", target: "research" },
        instrumentationCallId: "call-1",
        invocationId: "call-1:research",
        kind: "agent-invoke",
      },
    });
  });

  it("does not send the invocation before the owning task is admitted", async () => {
    const admission = Promise.withResolvers<{ readonly status: "accepted" }>();
    const replies: AgentInvocationReply[] = [
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: "call-1:research",
            kind: "subagent-result",
            origin: "child",
            output: "done",
            subagentName: "research",
          } as never,
        ],
      },
    ];
    mocks.createHook.mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          replies.length > 0
            ? { done: false as const, value: replies.shift()! }
            : { done: true as const, value: undefined },
      }),
      token: "agent-reply",
    });
    const ctx = { callId: "call-1" } as ToolContext;
    attachWorkflowToolRunContext(ctx, {
      admission: admission.promise,
      from: {
        callId: "call-1",
        execution: "background",
        input: { message: "Find it" },
        runId: "run-1",
        sequence: 0,
        stepIndex: 0,
        toolName: "research",
        turnId: "turn-1",
      },
      owner: {
        admission: "owner-admission",
        outcome: "owner-outcome",
        report: "owner-report",
        request: "owner-request",
      },
    });

    const result = agent(ctx, { key: "research", message: "Find it", target: "research" });
    await Promise.resolve();
    expect(mocks.resumeHook).not.toHaveBeenCalled();

    admission.resolve({ status: "accepted" });
    await expect(result).resolves.toBe("done");
    expect(mocks.resumeHook).toHaveBeenCalledTimes(2);
  });

  it("waits for agent calls inside a blocking workflow tool", async () => {
    const result = {
      callId: "call-1:research",
      kind: "subagent-result" as const,
      origin: "child" as const,
      outcome: {
        kind: "parked" as const,
        result: { kind: "succeeded" as const, output: "inline" },
        usageDelta: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      output: "inline",
      subagentName: "research",
    };
    mocks.createHook.mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: { kind: "runtime-action-result", results: [result] },
          })
          .mockResolvedValue({ done: true }),
      }),
      token: "agent-reply",
    });
    const ctx = { callId: "call-1" } as ToolContext;
    attachWorkflowToolRunContext(ctx, {
      from: {
        callId: "call-1",
        execution: "blocking",
        input: { message: "Find it" },
        runId: "run-1",
        sequence: 0,
        stepIndex: 0,
        toolName: "research",
        turnId: "turn-1",
      },
      owner: {
        admission: "owner-admission",
        outcome: "owner-outcome",
        report: "owner-report",
        request: "owner-request",
      },
    });

    await expect(
      agent(ctx, { key: "research", message: "Find it", target: "research" }),
    ).resolves.toBe("inline");
    expect(mocks.resumeHook).toHaveBeenCalledTimes(2);
    expect(mocks.resumeHook).toHaveBeenNthCalledWith(1, "owner-request", {
      from: expect.objectContaining({ execution: "blocking", runId: "run-1" }),
      replyTo: "agent-reply",
      request: {
        input: { message: "Find it", target: "research" },
        instrumentationCallId: "call-1",
        invocationId: "call-1:research",
        kind: "agent-invoke",
      },
    });
  });

  it("rejects dispatch failures without reporting a child settlement", async () => {
    const failure = {
      callId: "call-1:research",
      isError: true as const,
      kind: "subagent-result" as const,
      origin: "dispatch" as const,
      output: {
        code: "REMOTE_AGENT_START_FAILED",
        message: "The remote agent could not be started.",
      },
      subagentName: "research",
    };
    mocks.createHook.mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: { kind: "runtime-action-result", results: [failure] },
          })
          .mockResolvedValue({ done: true }),
      }),
      token: "agent-reply",
    });
    const ctx = { callId: "call-1" } as ToolContext;
    attachWorkflowToolRunContext(ctx, {
      from: {
        callId: "call-1",
        execution: "blocking",
        input: { message: "Find it" },
        runId: "run-1",
        sequence: 0,
        stepIndex: 0,
        toolName: "research",
        turnId: "turn-1",
      },
      owner: {
        admission: "owner-admission",
        outcome: "owner-outcome",
        report: "owner-report",
        request: "owner-request",
      },
    });

    await expect(
      agent(ctx, { key: "research", message: "Find it", target: "research" }),
    ).rejects.toEqual(failure.output);
    expect(mocks.resumeHook).toHaveBeenCalledTimes(1);
    expect(mocks.resumeHook).not.toHaveBeenCalledWith(
      "owner-request",
      expect.objectContaining({ request: expect.objectContaining({ kind: "agent-settled" }) }),
    );
  });

  it("preserves each child HITL event's coordinates when relaying repeated requests", async () => {
    const childRequest = (input: {
      readonly requestId: string;
      readonly stepIndex: number;
    }): AgentInvocationReply => ({
      callId: "call-1",
      childContinuationToken: "child-continuation",
      childSessionId: "child-1",
      event: {
        requests: [
          {
            action: {
              callId: input.requestId,
              input: {},
              kind: "tool-call",
              toolName: "approval_gate",
            },
            kind: "tool-approval",
            prompt: "Approve?",
            requestId: input.requestId,
          },
        ],
        sequence: 3,
        stepIndex: input.stepIndex,
        turnId: "turn-child",
      },
      kind: "subagent-input-request",
      subagentName: "research",
    });
    const replies: AgentInvocationReply[] = [
      childRequest({ requestId: "approval-1", stepIndex: 1 }),
      childRequest({ requestId: "approval-2", stepIndex: 2 }),
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: "call-1:research",
            kind: "subagent-result",
            origin: "child",
            output: "done",
            subagentName: "research",
          } as never,
        ],
      },
    ];
    mocks.createHook.mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          replies.length > 0
            ? { done: false as const, value: replies.shift()! }
            : { done: true as const, value: undefined },
      }),
      token: "agent-reply",
    });
    mocks.resumeHook.mockImplementation(async () => undefined);
    const from: WorkflowToolRunRef = {
      callId: "call-1",
      execution: "background",
      input: { message: "Find it" },
      runId: "run-1",
      sequence: 0,
      stepIndex: 0,
      toolName: "research",
      turnId: "turn-parent",
    };
    const ctx = { callId: "call-1" } as ToolContext;
    attachWorkflowToolRunContext(ctx, {
      admission: Promise.resolve({ status: "accepted" }),
      from,
      owner: {
        admission: "owner-admission",
        outcome: "owner-outcome",
        report: "owner-report",
        request: "owner-request",
      },
    });

    await expect(
      agent(ctx, { key: "research", message: "Find it", target: "research" }),
    ).resolves.toBe("done");

    expect(mocks.resumeHook).toHaveBeenNthCalledWith(2, "owner-request", {
      from,
      replyTo: "child-continuation",
      request: {
        kind: "input-batch",
        requests: [expect.objectContaining({ requestId: "approval-1" })],
      },
      requestCoordinates: { sequence: 3, stepIndex: 1, turnId: "turn-child" },
    });
    expect(mocks.resumeHook).toHaveBeenNthCalledWith(3, "owner-request", {
      from,
      replyTo: "child-continuation",
      request: {
        kind: "input-batch",
        requests: [expect.objectContaining({ requestId: "approval-2" })],
      },
      requestCoordinates: { sequence: 3, stepIndex: 2, turnId: "turn-child" },
    });
  });

  it("forwards background authorization as an owner authorization request", async () => {
    const replies: AgentInvocationReply[] = [
      {
        callId: "call-1",
        childSessionId: "child-1",
        event: {
          data: {
            description: "Authorize Linear",
            name: "linear",
            sequence: 1,
            stepIndex: 2,
            turnId: "turn-child",
          },
          type: "authorization.required",
        },
        kind: "subagent-authorization-event",
        subagentName: "research",
      },
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: "call-1:research",
            kind: "subagent-result",
            origin: "child",
            output: "done",
            subagentName: "research",
          } as never,
        ],
      },
    ];
    mocks.createHook.mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          replies.length > 0
            ? { done: false as const, value: replies.shift()! }
            : { done: true as const, value: undefined },
      }),
      token: "agent-reply",
    });
    mocks.resumeHook.mockImplementation(async () => undefined);
    const from: WorkflowToolRunRef = {
      callId: "call-1",
      execution: "background",
      input: { message: "Find it", target: "research" },
      runId: "run-1",
      sequence: 0,
      stepIndex: 2,
      toolName: "research",
      turnId: "turn-1",
    };
    const ctx = { callId: "call-1" } as ToolContext;
    attachWorkflowToolRunContext(ctx, {
      admission: Promise.resolve({ status: "accepted" }),
      from,
      owner: {
        admission: "owner-admission",
        outcome: "owner-outcome",
        report: "owner-report",
        request: "owner-request",
      },
    });

    await expect(
      agent(ctx, { key: "research", message: "Find it", target: "research" }),
    ).resolves.toBe("done");

    expect(mocks.resumeHook).toHaveBeenCalledWith("owner-request", {
      from,
      replyTo: "agent-reply",
      request: {
        event: expect.objectContaining({ kind: "subagent-authorization-event" }),
        kind: "authorization-request",
      },
    });
    expect(mocks.resumeHook).not.toHaveBeenCalledWith("owner-report", expect.anything());
  });

  it("forwards task-owned child updates to the workflow tool report channel", async () => {
    const replies: AgentInvocationReply[] = [
      {
        callId: "task-update-call",
        kind: "task-update",
        message: "Still working",
        updateEpoch: "turn-child",
        updateIndex: 0,
      },
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: "call-1:research",
            kind: "subagent-result",
            origin: "child",
            output: "done",
            subagentName: "research",
          } as never,
        ],
      },
    ];
    mocks.createHook.mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          replies.length > 0
            ? { done: false as const, value: replies.shift()! }
            : { done: true as const, value: undefined },
      }),
      token: "agent-reply",
    });
    mocks.resumeHook.mockImplementation(async () => undefined);
    const from: WorkflowToolRunRef = {
      callId: "call-1",
      execution: "background",
      input: { message: "Find it", target: "research" },
      runId: "run-1",
      sequence: 0,
      stepIndex: 2,
      toolName: "research",
      turnId: "turn-1",
    };
    const ctx = { callId: "call-1" } as ToolContext;
    attachWorkflowToolRunContext(ctx, {
      admission: Promise.resolve({ status: "accepted" }),
      from,
      owner: {
        admission: "owner-admission",
        outcome: "owner-outcome",
        report: "owner-report",
        request: "owner-request",
      },
    });

    await expect(
      agent(ctx, { key: "research", message: "Find it", target: "research" }),
    ).resolves.toBe("done");

    expect(mocks.resumeHook).toHaveBeenCalledWith("owner-report", {
      from,
      update: "Still working",
    });
  });
});
