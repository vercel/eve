import { beforeEach, describe, expect, it, vi } from "vitest";

import { ask, attachWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";
import {
  agent,
  type AgentInvocationReply,
  validateAgentInput,
} from "#execution/tools/subagent/invoke-agent.js";
import type { ToolContext } from "#tools/definition.js";

const mocks = vi.hoisted(() => ({
  createHook: vi.fn(),
  disposeHook: vi.fn(),
  resumeHook: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createHook: mocks.createHook,
}));
vi.mock("#execution/hook-ownership.js", () => ({
  disposeHook: mocks.disposeHook,
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: (...args: unknown[]) => mocks.resumeHook(...args),
}));
beforeEach(() => vi.resetAllMocks());

describe("workflow helper context errors", () => {
  it.each([
    ["ordinary tool", { callId: "call-1", session: {} }],
    ["channel handler", { from() {}, to() {}, waitUntil() {} }],
    ["schedule handler", { to() {}, waitUntil() {}, appAuth: {} }],
    ["missing context", undefined],
    ["null context", null],
  ])("rejects %s before creating hooks or dispatching work", async (_name, context) => {
    const ctx = context as ToolContext;
    await expect(agent(ctx, "reviewer", { message: "Review" })).rejects.toThrow(
      "ctx.agent() requires a defineWorkflowTool() executor context.",
    );
    expect(() => ask(ctx, { prompt: "Continue?" })).toThrow(
      "ctx.ask() requires a defineWorkflowTool() executor context.",
    );
    expect(mocks.createHook).not.toHaveBeenCalled();
    expect(mocks.resumeHook).not.toHaveBeenCalled();
  });
});

describe("agent invocation input", () => {
  it("requires a non-empty positional agent name", () => {
    expect(() => validateAgentInput({ message: "Review", target: "" })).toThrow(
      "agent() requires a non-empty agent name as its first argument.",
    );
  });
});

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
        inbox: "owner-inbox",
      },
    });

    const result = agent(ctx, "research", { message: "Find it" });
    await vi.waitFor(() => expect(mocks.resumeHook).toHaveBeenCalledOnce());
    controller.abort(new Error("task cancelled"));

    await expect(result).rejects.toThrow("task cancelled");
    expect(mocks.disposeHook).toHaveBeenCalledOnce();
  });

  it("sends the invocation through the task owner after admission", async () => {
    const result = {
      callId: "call-1:agent-reply",
      kind: "subagent-result" as const,
      origin: "child" as const,
      outcome: {
        kind: "parked" as const,
        result: { kind: "succeeded" as const, output: { findings: ["available"] } },
        usageDelta: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      output: { findings: ["available"] },
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
        inbox: "owner-inbox",
      },
    });

    const outputSchema = {
      properties: { findings: { items: { type: "string" }, type: "array" } },
      required: ["findings"],
      type: "object",
    };
    await expect(agent(ctx, "research", { message: "Find it", outputSchema })).resolves.toEqual({
      findings: ["available"],
    });

    expect(mocks.resumeHook).toHaveBeenCalledWith("owner-inbox", {
      kind: "request",
      from,
      replyTo: "agent-reply",
      request: {
        input: { message: "Find it", outputSchema, target: "research" },
        invocationId: "call-1:agent-reply",
        kind: "agent-invoke",
      },
    });
  });

  it("derives unique invocation ids for repeated parallel calls", async () => {
    for (const token of ["reply-1", "reply-2"]) {
      const replies: AgentInvocationReply[] = [
        {
          kind: "runtime-action-result",
          results: [
            {
              callId: `call-1:${token}`,
              kind: "subagent-result",
              origin: "child",
              output: token,
              subagentName: "research",
            } as never,
          ],
        },
      ];
      mocks.createHook.mockReturnValueOnce({
        [Symbol.asyncIterator]: () => ({
          next: async () =>
            replies.length > 0
              ? { done: false as const, value: replies.shift()! }
              : { done: true as const, value: undefined },
        }),
        token,
      });
    }
    mocks.resumeHook.mockImplementation(async () => undefined);
    const ctx = { callId: "call-1" } as ToolContext;
    attachWorkflowToolRunContext(ctx, {
      from: {
        callId: "call-1",
        execution: "blocking",
        input: {},
        runId: "run-1",
        sequence: 0,
        stepIndex: 0,
        toolName: "research",
        turnId: "turn-1",
      },
      owner: { inbox: "owner-inbox" },
    });

    await expect(
      Promise.all([
        agent(ctx, "research", { message: "First" }),
        agent(ctx, "research", { message: "Second" }),
      ]),
    ).resolves.toEqual(["reply-1", "reply-2"]);

    const requests = mocks.resumeHook.mock.calls
      .map(([, message]) => message.request)
      .filter((request) => request.kind === "agent-invoke");
    expect(requests.map((request) => request.invocationId)).toEqual([
      "call-1:reply-1",
      "call-1:reply-2",
    ]);
  });

  it("does not send the invocation before the owning task is admitted", async () => {
    const admission = Promise.withResolvers<{ readonly status: "accepted" }>();
    const replies: AgentInvocationReply[] = [
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: "call-1:agent-reply",
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
        inbox: "owner-inbox",
      },
    });

    const result = agent(ctx, "research", { message: "Find it" });
    await Promise.resolve();
    expect(mocks.createHook).not.toHaveBeenCalled();
    expect(mocks.resumeHook).not.toHaveBeenCalled();

    admission.resolve({ status: "accepted" });
    await expect(result).resolves.toBe("done");
    expect(mocks.resumeHook).toHaveBeenCalledTimes(2);
  });

  it("waits for agent calls inside a blocking workflow tool", async () => {
    const result = {
      callId: "call-1:agent-reply",
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
        inbox: "owner-inbox",
      },
    });

    await expect(agent(ctx, "research", { message: "Find it" })).resolves.toBe("inline");
    expect(mocks.resumeHook).toHaveBeenCalledTimes(2);
    expect(mocks.resumeHook).toHaveBeenNthCalledWith(1, "owner-inbox", {
      kind: "request",
      from: expect.objectContaining({ execution: "blocking", runId: "run-1" }),
      replyTo: "agent-reply",
      request: {
        input: { message: "Find it", target: "research" },
        invocationId: "call-1:agent-reply",
        kind: "agent-invoke",
      },
    });
  });

  it("rejects dispatch failures without reporting a child settlement", async () => {
    const failure = {
      callId: "call-1:agent-reply",
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
        inbox: "owner-inbox",
      },
    });

    await expect(agent(ctx, "research", { message: "Find it" })).rejects.toEqual(failure.output);
    expect(mocks.resumeHook).toHaveBeenCalledTimes(1);
    expect(mocks.resumeHook).not.toHaveBeenCalledWith(
      "owner-inbox",
      expect.objectContaining({ request: expect.objectContaining({ kind: "agent-settled" }) }),
    );
  });

  it.each([false, true])(
    "preserves child HITL coordinates and routes advertised inboxes: %s",
    async (advertiseInbox) => {
      const childRequest = (input: {
        readonly requestId: string;
        readonly stepIndex: number;
      }): AgentInvocationReply => ({
        callId: "call-1",
        childContinuationToken: "child-continuation",
        childSessionId: "child-1",
        childSessionInbox: advertiseInbox ? { sessionId: "child-1", version: 1 } : undefined,
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
              callId: "call-1:agent-reply",
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
          inbox: "owner-inbox",
        },
      });

      await expect(agent(ctx, "research", { message: "Find it" })).resolves.toBe("done");

      expect(mocks.resumeHook).toHaveBeenNthCalledWith(2, "owner-inbox", {
        kind: "request",
        from,
        replyTo: advertiseInbox ? "eve:session:child-1:inbox" : "child-continuation",
        request: {
          kind: "input-batch",
          requests: [expect.objectContaining({ requestId: "approval-1" })],
        },
        requestCoordinates: { sequence: 3, stepIndex: 1, turnId: "turn-child" },
      });
      expect(mocks.resumeHook).toHaveBeenNthCalledWith(3, "owner-inbox", {
        kind: "request",
        from,
        replyTo: advertiseInbox ? "eve:session:child-1:inbox" : "child-continuation",
        request: {
          kind: "input-batch",
          requests: [expect.objectContaining({ requestId: "approval-2" })],
        },
        requestCoordinates: { sequence: 3, stepIndex: 2, turnId: "turn-child" },
      });
    },
  );

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
            callId: "call-1:agent-reply",
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
        inbox: "owner-inbox",
      },
    });

    await expect(agent(ctx, "research", { message: "Find it" })).resolves.toBe("done");

    expect(mocks.resumeHook).toHaveBeenCalledWith("owner-inbox", {
      kind: "request",
      from,
      replyTo: "agent-reply",
      request: {
        event: expect.objectContaining({ kind: "subagent-authorization-event" }),
        kind: "authorization-request",
      },
    });
    expect(mocks.resumeHook).not.toHaveBeenCalledWith(
      "owner-inbox",
      expect.objectContaining({ kind: "report" }),
    );
  });
});
