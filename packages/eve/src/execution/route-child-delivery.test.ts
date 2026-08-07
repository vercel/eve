import { beforeEach, describe, expect, it, vi } from "vitest";

import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { emitRecordedTaskInputRequestStep } from "#execution/subagent-event-proxy-step.js";
import { recordTaskInputRequestStep } from "#execution/tasks/hitl-proxy-steps.js";
import { routeProxiedDeliverStep } from "#execution/proxied-deliver-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";

vi.mock("#execution/subagent-event-proxy-step.js", () => ({
  emitRecordedTaskInputRequestStep: vi.fn(),
}));
vi.mock("#execution/tasks/hitl-proxy-steps.js", () => ({
  recordTaskInputRequestStep: vi.fn(),
}));
vi.mock("#execution/proxied-deliver-step.js", () => ({
  routeProxiedDeliverStep: vi.fn(),
}));

const state = (hasProxyInputRequests: boolean): DurableSessionState => ({
  continuationToken: "parent-token",
  emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "" },
  hasProxyInputRequests,
  sessionId: "parent-session",
  version: 1,
});

const hookPayload = {
  callId: "call-task",
  childContinuationToken: "child-token",
  childSessionId: "child-session",
  event: {
    requests: [
      {
        action: { callId: "call-q", input: {}, kind: "tool-call" as const, toolName: "ask" },
        kind: "question" as const,
        prompt: "Which?",
        requestId: "request-1",
      },
    ],
    sequence: 1,
    stepIndex: 2,
    turnId: "turn_child",
  },
  kind: "subagent-input-request" as const,
  subagentName: "research",
};

describe("task HITL delivery routing", () => {
  beforeEach(() => vi.resetAllMocks());

  it("commits the task route before emitting and consumes the framework-only delivery", async () => {
    const recordedState = state(true);
    vi.mocked(recordTaskInputRequestStep).mockResolvedValue({
      accepted: true,
      sessionState: recordedState,
    });
    vi.mocked(emitRecordedTaskInputRequestStep).mockResolvedValue({
      serializedContext: { adapter: "updated" },
      sessionState: recordedState,
    });
    vi.mocked(routeProxiedDeliverStep).mockResolvedValue({
      kind: "continue",
      remainder: undefined,
      serializedContext: { adapter: "updated" },
      sessionState: recordedState,
    });

    const result = await routeDeliverToChildren({
      parentWritable: new WritableStream<Uint8Array>(),
      payloads: [{ taskInputRequests: [{ hookPayload, taskId: "task-1" }] }],
      serializedContext: {},
      sessionState: state(false),
    });

    expect(result).toMatchObject({ kind: "continue", remainder: undefined });
    expect(recordTaskInputRequestStep).toHaveBeenCalledOnce();
    expect(emitRecordedTaskInputRequestStep).toHaveBeenCalledOnce();
    expect(vi.mocked(recordTaskInputRequestStep).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(emitRecordedTaskInputRequestStep).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("drops an unowned task envelope before it can reach the parent model", async () => {
    vi.mocked(recordTaskInputRequestStep).mockResolvedValue({
      accepted: false,
      sessionState: state(false),
    });

    const result = await routeDeliverToChildren({
      parentWritable: new WritableStream<Uint8Array>(),
      payloads: [{ taskInputRequests: [{ hookPayload, taskId: "foreign-task" }] }],
      serializedContext: {},
      sessionState: state(false),
    });

    expect(result).toMatchObject({ kind: "continue", remainder: undefined });
    expect(emitRecordedTaskInputRequestStep).not.toHaveBeenCalled();
    expect(routeProxiedDeliverStep).not.toHaveBeenCalled();
  });
});
