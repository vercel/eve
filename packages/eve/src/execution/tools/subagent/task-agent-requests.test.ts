import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyTaskAgentRequest } from "#execution/tools/subagent/task-agent-requests.js";
import {
  dispatchTaskAgentInvocationStep,
  settleTaskAgentInvocationStep,
} from "#execution/tools/subagent/invoke-step.js";
import {
  emitSubagentEventStep,
  dispatchSessionEventHooksStep,
} from "#execution/tools/subagent/emit-event-step.js";
import { stampTestEvent } from "#internal/testing/events.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";

vi.mock("#execution/tools/subagent/invoke-step.js", () => ({
  dispatchTaskAgentInvocationStep: vi.fn(),
  settleTaskAgentInvocationStep: vi.fn(),
}));
vi.mock("#execution/tools/subagent/emit-event-step.js", () => ({
  emitSubagentEventStep: vi.fn(),
  dispatchSessionEventHooksStep: vi.fn(),
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

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(dispatchSessionEventHooksStep).mockImplementation(async (input) => ({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  }));
});

describe("workflow-owned agent requests", () => {
  it("reuses the settlement step's flushed trace context during workflow replay", async () => {
    const serializedContext = { "eve.test": "before" };
    const flushedContext = { "eve.test": "after" };
    vi.mocked(settleTaskAgentInvocationStep).mockResolvedValue({
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
    const settled = await applyTaskAgentRequest(delivery, context);

    expect(settleTaskAgentInvocationStep).toHaveBeenCalledWith({
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

  it.each([false, true])(
    "runs completion hooks after publication and before acknowledgement (hook fails: %s)",
    async (fails) => {
      const updatedState = { sessionId: "updated" } as never;
      const hookState = { sessionId: "hooked" } as never;
      const completion = {
        type: "subagent.completed" as const,
        data: { callId: "nested", subagentName: "research", output: "done" },
      };
      const event = stampTestEvent(completion);
      vi.mocked(settleTaskAgentInvocationStep).mockResolvedValue({
        settled: true,
        completion,
        serializedContext: {},
        sessionState: updatedState,
      });
      const publication =
        Promise.withResolvers<Awaited<ReturnType<typeof emitSubagentEventStep>>>();
      const hooks =
        Promise.withResolvers<Awaited<ReturnType<typeof dispatchSessionEventHooksStep>>>();
      vi.mocked(emitSubagentEventStep).mockReturnValue(publication.promise);
      vi.mocked(dispatchSessionEventHooksStep).mockReturnValue(hooks.promise);
      const applying = applyTaskAgentRequest(
        { ownerId: "workflow-run", replyTo: "reply", request: { kind: "agent-settled", result } },
        { sessionWritable: {} as never, serializedContext: {}, sessionState },
      );
      await vi.waitFor(() => expect(emitSubagentEventStep).toHaveBeenCalledOnce());
      expect(dispatchSessionEventHooksStep).not.toHaveBeenCalled();
      expect(resumeHookStep).not.toHaveBeenCalled();
      publication.resolve({ event, suppressed: false, serializedContext: { channel: true } });
      await vi.waitFor(() =>
        expect(dispatchSessionEventHooksStep).toHaveBeenCalledExactlyOnceWith({
          event,
          suppressed: false,
          serializedContext: { channel: true },
          sessionState: updatedState,
        }),
      );
      expect(resumeHookStep).not.toHaveBeenCalled();
      if (fails) {
        const rejected = expect(applying).rejects.toThrow("hook failed");
        hooks.reject(new Error("hook failed"));
        await rejected;
        expect(emitSubagentEventStep).toHaveBeenCalledOnce();
        expect(resumeHookStep).not.toHaveBeenCalled();
      } else {
        hooks.resolve({ serializedContext: { hook: true }, sessionState: hookState });
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
    vi.mocked(settleTaskAgentInvocationStep).mockRejectedValue(new Error("write failed"));
    await expect(
      applyTaskAgentRequest(
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
    vi.mocked(dispatchTaskAgentInvocationStep).mockResolvedValue({
      agentId: "child",
      event,
      kind: "dispatched",
      sessionState,
    });
    vi.mocked(emitSubagentEventStep).mockResolvedValue({
      event,
      suppressed: false,
      serializedContext,
    });

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
});
