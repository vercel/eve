import { beforeEach, describe, expect, it, vi } from "vitest";

import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import {
  emitRecordedTaskInputRequestStep,
  runProxySubagentEventStep,
} from "#execution/subagent-event-proxy-step.js";
import {
  acceptTaskAgentEventStep,
  recordTaskInputRequestStep,
} from "#execution/task-hitl-proxy-steps.js";
import { routeProxiedDeliverStep } from "#execution/proxied-deliver-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";

vi.mock("#execution/subagent-event-proxy-step.js", () => ({
  emitRecordedTaskInputRequestStep: vi.fn(),
  runProxySubagentEventStep: vi.fn(),
}));
vi.mock("#execution/task-hitl-proxy-steps.js", () => ({
  acceptTaskAgentEventStep: vi.fn(),
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

const taskRequest = {
  replyTo: "eve:workflow-tool-run-answer:run-1:0",
  request: {
    action: { callId: "call-q", input: {}, kind: "tool-call" as const, toolName: "ask" },
    kind: "question" as const,
    prompt: "Which?",
    requestId: "request-1",
  },
  sequence: 1,
  stepIndex: 2,
  taskId: "task-1",
  turnId: "turn_child",
};
describe("task HITL delivery routing", () => {
  beforeEach(() => vi.resetAllMocks());

  it("commits the task route before emitting and consumes the framework-only delivery", async () => {
    const recordedState = state(true);
    vi.mocked(recordTaskInputRequestStep).mockResolvedValue({
      accepted: true,
      request: taskRequest,
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
        payloads: [{ task: { inputRequests: [taskRequest] } }],
      },
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(false),
    });

    expect(result).toMatchObject({ kind: "continue", remainder: undefined });
    expect(recordTaskInputRequestStep).toHaveBeenCalledOnce();
    expect(recordTaskInputRequestStep).toHaveBeenCalledWith(
      expect.objectContaining({ request: taskRequest }),
    );
    expect(emitRecordedTaskInputRequestStep).toHaveBeenCalledOnce();
    expect(emitRecordedTaskInputRequestStep).toHaveBeenCalledWith(
      expect.objectContaining({ request: taskRequest }),
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
        payloads: [{ task: { inputRequests: [{ ...taskRequest, taskId: "foreign-task" }] } }],
      },
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(false),
    });

    expect(result).toMatchObject({ kind: "continue", remainder: undefined });
    expect(emitRecordedTaskInputRequestStep).not.toHaveBeenCalled();
    expect(routeProxiedDeliverStep).not.toHaveBeenCalled();
  });

  it("proxies a task-owned agent authorization event through the parent channel", async () => {
    const nextState = state(false);
    const event = {
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
        type: "authorization.required" as const,
      },
      kind: "subagent-authorization-event" as const,
      subagentName: "research",
    };
    vi.mocked(runProxySubagentEventStep).mockResolvedValue({
      serializedContext: { adapter: "updated" },
      sessionState: nextState,
    });
    vi.mocked(acceptTaskAgentEventStep).mockResolvedValue({
      accepted: true,
      hookPayload: event,
    });

    const result = await routeDeliverToChildren({
      delivery: {
        kind: "deliver",
        payloads: [
          {
            task: {
              effects: [
                {
                  input: event,
                  name: "agent.event",
                  replyTo: "agent-reply",
                  taskId: "task-1",
                },
              ],
            },
          },
        ],
      },
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(false),
    });

    expect(acceptTaskAgentEventStep).toHaveBeenCalledWith(
      expect.objectContaining({ effect: expect.objectContaining({ taskId: "task-1" }) }),
    );
    expect(runProxySubagentEventStep).toHaveBeenCalledWith(
      expect.objectContaining({ hookPayload: event }),
    );
    expect(result).toMatchObject({
      kind: "continue",
      serializedContext: { adapter: "updated" },
      sessionState: nextState,
    });
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
