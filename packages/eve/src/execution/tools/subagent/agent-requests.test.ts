import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyAgentRequest } from "#execution/tools/subagent/agent-requests.js";
import {
  dispatchAgentInvocationStep,
  settleAgentInvocationStep,
} from "#execution/tools/subagent/invoke-step.js";
import { emitSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";

vi.mock("#execution/tools/subagent/invoke-step.js", () => ({
  dispatchAgentInvocationStep: vi.fn(),
  settleAgentInvocationStep: vi.fn(),
}));
vi.mock("#execution/tools/subagent/emit-event-step.js", () => ({
  emitSubagentEventStep: vi.fn(),
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

beforeEach(() => vi.resetAllMocks());

describe("workflow-owned agent requests", () => {
  it("reuses the settlement step's flushed trace context during workflow replay", async () => {
    const serializedContext = { "eve.test": "before" };
    const flushedContext = { "eve.test": "after" };
    vi.mocked(settleAgentInvocationStep).mockResolvedValue({
      settled: false,
      serializedContext: flushedContext,
      sessionState,
    });
    const delivery = {
      ownerId: "workflow-run",
      replyTo: "reply",
      request: { kind: "agent-settled" as const, result },
    };
    const context = { sessionWritable: {} as never, serializedContext, sessionState };
    const settled = await applyAgentRequest(delivery, context);

    expect(settleAgentInvocationStep).toHaveBeenCalledWith({
      ownerId: "workflow-run",
      result,
      serializedContext,
      sessionState,
    });
    expect(settled.serializedContext).toBe(flushedContext);
    const replay = await applyAgentRequest(delivery, context);
    expect(replay).toEqual(settled);
  });

  it.each([false, true])(
    "waits for notification hooks before acknowledgement and retains their state (fails: %s)",
    async (fails) => {
      const updatedState = { sessionId: "updated" } as never;
      const hookState = { sessionId: "hooked" } as never;
      const completion = {
        type: "subagent.completed" as const,
        data: { callId: "nested", subagentName: "research", output: "done" },
      };
      vi.mocked(settleAgentInvocationStep).mockResolvedValue({
        settled: true,
        completion,
        serializedContext: {},
        sessionState: updatedState,
      });
      const notification =
        Promise.withResolvers<Awaited<ReturnType<typeof emitSubagentEventStep>>>();
      vi.mocked(emitSubagentEventStep).mockReturnValue(notification.promise);
      const applying = applyAgentRequest(
        { ownerId: "workflow-run", replyTo: "reply", request: { kind: "agent-settled", result } },
        { sessionWritable: {} as never, serializedContext: {}, sessionState },
      );
      await vi.waitFor(() => expect(emitSubagentEventStep).toHaveBeenCalledOnce());
      expect(resumeHookStep).not.toHaveBeenCalled();
      if (fails) {
        const rejected = expect(applying).rejects.toThrow("hook failed");
        notification.reject(new Error("hook failed"));
        await rejected;
        expect(emitSubagentEventStep).toHaveBeenCalledOnce();
        expect(resumeHookStep).not.toHaveBeenCalled();
      } else {
        notification.resolve({ serializedContext: { hook: true }, sessionState: hookState });
        expect(await applying).toEqual({
          serializedContext: { hook: true },
          sessionState: hookState,
        });
        expect(resumeHookStep).toHaveBeenCalledExactlyOnceWith(
          "reply",
          { kind: "agent-settled", callId: "nested" },
          { ifPresent: true },
        );
      }
    },
  );

  it("does not acknowledge a failed settlement", async () => {
    vi.mocked(settleAgentInvocationStep).mockRejectedValue(new Error("write failed"));
    await expect(
      applyAgentRequest(
        { ownerId: "workflow-run", replyTo: "reply", request: { kind: "agent-settled", result } },
        { sessionWritable: {} as never, serializedContext: {}, sessionState },
      ),
    ).rejects.toThrow("write failed");
    expect(resumeHookStep).not.toHaveBeenCalled();
  });

  it("retains existing context when replaying a dispatch result without tracing state", async () => {
    const receiver = {
      attributes: {},
      authenticator: "test-idp",
      principalId: "receiver",
      principalType: "user",
    };
    const serializedContext = {
      "eve.auth": receiver,
      "eve.initiatorAuth": receiver,
      "eve.test": "preserved",
    };
    const event = { type: "subagent.called" } as never;
    vi.mocked(dispatchAgentInvocationStep).mockResolvedValue({
      agentId: "child",
      event,
      kind: "dispatched",
      sessionState,
    });
    vi.mocked(emitSubagentEventStep).mockResolvedValue({
      sessionState,
      serializedContext,
    });

    const applied = await applyAgentRequest(
      {
        ownerId: "workflow-run",
        replyTo: "reply",
        request: {
          input: { message: "Find it", target: "research" },
          invocationId: "nested",
          kind: "agent-invoke",
        },
      },
      { sessionWritable: {} as never, serializedContext, sessionState },
    );

    expect(emitSubagentEventStep).toHaveBeenCalledWith({
      event,
      sessionWritable: {},
      serializedContext,
      sessionState,
    });
    expect(applied.serializedContext).toBe(serializedContext);
  });

  it("replies to the workflow with an immediate dispatch error", async () => {
    const failedState = { sessionId: "failed" } as never;
    const failure = {
      callId: "nested",
      isError: true as const,
      kind: "subagent-result" as const,
      origin: "dispatch" as const,
      output: { code: "AGENT_UNREACHABLE", message: "gone" },
      subagentName: "research",
    };
    vi.mocked(dispatchAgentInvocationStep).mockResolvedValue({
      kind: "failed",
      result: failure,
      sessionState: failedState,
    });
    const request = {
      input: { message: "Find it", target: "research" },
      invocationId: "nested",
      kind: "agent-invoke" as const,
    };

    const applied = await applyAgentRequest(
      { ownerId: "workflow-run", replyTo: "reply", request },
      { sessionWritable: {} as never, serializedContext: { source: "parent" }, sessionState },
    );

    expect(dispatchAgentInvocationStep).toHaveBeenCalledWith({
      ownerId: "workflow-run",
      replyTo: "reply",
      request,
      serializedContext: { source: "parent" },
      sessionState,
    });
    expect(resumeHookStep).toHaveBeenCalledWith("reply", {
      kind: "runtime-action-result",
      results: [failure],
    });
    expect(emitSubagentEventStep).not.toHaveBeenCalled();
    expect(applied).toEqual({
      serializedContext: { source: "parent" },
      sessionState: failedState,
    });
  });
});
