import { beforeEach, describe, expect, it, vi } from "vitest";

import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { emitRecordedTaskInputRequestStep } from "#execution/subagent-event-proxy-step.js";
import { emitTaskViewDeliveriesStep } from "#execution/tasks/parent/client-events.js";
import { recordTaskInputRequestStep } from "#execution/tasks/parent/hitl-proxy-steps.js";
import { routeProxiedDeliverStep } from "#execution/proxied-deliver-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";

vi.mock("#execution/subagent-event-proxy-step.js", () => ({
  emitRecordedTaskInputRequestStep: vi.fn(),
}));
vi.mock("#execution/tasks/parent/client-events.js", () => ({
  emitTaskViewDeliveriesStep: vi.fn(),
}));
vi.mock("#execution/tasks/parent/hitl-proxy-steps.js", () => ({
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

  it("emits task views with their framework notification and consumes the task envelope", async () => {
    const emittedState = state(false);
    vi.mocked(emitTaskViewDeliveriesStep).mockResolvedValue({
      serializedContext: { adapter: "updated" },
      sessionState: emittedState,
    });
    const view = {
      metadata: {
        agentId: "agent_1",
        kind: "subagent" as const,
        mode: "local" as const,
        name: "research",
      },
      status: "working" as const,
      taskId: "task-1",
    };

    const result = await routeDeliverToChildren({
      delivery: {
        kind: "deliver",
        payloads: [{ message: "Checking inventory.", task: { views: [view] } }],
      },
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(false),
    });

    expect(emitTaskViewDeliveriesStep).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveries: [{ message: "Checking inventory.", view }],
      }),
    );
    expect(result).toMatchObject({
      kind: "continue",
      serializedContext: { adapter: "updated" },
      sessionState: emittedState,
    });
  });

  it("commits the task route before emitting and consumes the framework-only delivery", async () => {
    const recordedState = state(true);
    vi.mocked(recordTaskInputRequestStep).mockResolvedValue({
      accepted: true,
      hookPayload,
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
      delivery: {
        kind: "deliver",
        payloads: [{ task: { inputRequests: [{ hookPayload, taskId: "task-1" }] } }],
      },
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(false),
    });

    expect(result).toMatchObject({ kind: "continue", remainder: undefined });
    expect(recordTaskInputRequestStep).toHaveBeenCalledOnce();
    expect(emitRecordedTaskInputRequestStep).toHaveBeenCalledOnce();
    expect(emitRecordedTaskInputRequestStep).toHaveBeenCalledWith(
      expect.objectContaining({ hookPayload }),
    );
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
      delivery: {
        kind: "deliver",
        payloads: [{ task: { inputRequests: [{ hookPayload, taskId: "foreign-task" }] } }],
      },
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(false),
    });

    expect(result).toMatchObject({ kind: "continue", remainder: undefined });
    expect(emitRecordedTaskInputRequestStep).not.toHaveBeenCalled();
    expect(routeProxiedDeliverStep).not.toHaveBeenCalled();
  });

  it("reindexes ordinary metadata after consuming task-only payloads", async () => {
    const routedState = state(true);
    vi.mocked(routeProxiedDeliverStep).mockResolvedValue({
      kind: "continue",
      remainder: undefined,
      serializedContext: {},
      sessionState: routedState,
    });
    const caller = {
      callId: "call-parent",
      replyTo: { kind: "hook" as const, token: "parent-turn" },
      subagentName: "research",
    };

    await routeDeliverToChildren({
      delivery: {
        caller,
        deliveryMetadata: [
          { channelKind: "test", channelName: "main", deliveryId: "task", payloadIndex: 0 },
          { channelKind: "test", channelName: "main", deliveryId: "ordinary", payloadIndex: 1 },
        ],
        kind: "deliver",
        payloads: [{ task: { views: [] } }, { message: "parent message" }],
        requestId: "request-1",
        taskDeliveryId: "task-delivery-1",
        turnPolicy: "queue",
      },
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: routedState,
    });

    expect(routeProxiedDeliverStep).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: {
          caller,
          deliveryMetadata: [expect.objectContaining({ deliveryId: "ordinary", payloadIndex: 0 })],
          kind: "deliver",
          payloads: [{ message: "parent message" }],
          requestId: "request-1",
          taskDeliveryId: "task-delivery-1",
          turnPolicy: "queue",
        },
      }),
    );
  });
});
