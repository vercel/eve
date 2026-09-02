import { beforeEach, describe, expect, it, vi } from "vitest";

import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import {
  emitRecordedTaskInputRequestStep,
  runProxySubagentEventStep,
} from "#subagents/event-proxy-step.js";
import { recordTaskInputRequestStep } from "#execution/tasks/parent/hitl-proxy-steps.js";
import { acceptTaskAuthorizationEventStep } from "#execution/tools/subagent/accept-event-step.js";
import { routeProxiedDeliverStep } from "#execution/proxied-deliver-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { dispatchTaskAgentInvocationStep } from "#execution/tools/subagent/invoke-step.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";

vi.mock("#subagents/event-proxy-step.js", () => ({
  emitRecordedTaskInputRequestStep: vi.fn(),
  runProxySubagentEventStep: vi.fn(),
}));
vi.mock("#execution/tasks/parent/hitl-proxy-steps.js", () => ({
  recordTaskInputRequestStep: vi.fn(),
}));
vi.mock("#execution/tools/subagent/accept-event-step.js", () => ({
  acceptTaskAuthorizationEventStep: vi.fn(),
}));
vi.mock("#execution/proxied-deliver-step.js", () => ({
  routeProxiedDeliverStep: vi.fn(),
}));
vi.mock("#execution/tools/subagent/invoke-step.js", () => ({
  dispatchTaskAgentInvocationStep: vi.fn(),
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: vi.fn(),
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
    vi.mocked(acceptTaskAuthorizationEventStep).mockResolvedValue(true);

    const result = await routeDeliverToChildren({
      delivery: {
        kind: "deliver",
        payloads: [
          {
            task: {
              authorizationEvents: [{ hookPayload: event, taskId: "task-1" }],
            },
          },
        ],
      },
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state(false),
    });

    expect(acceptTaskAuthorizationEventStep).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: { hookPayload: event, taskId: "task-1" },
      }),
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

  it("dispatches agent invocations against the parent state and replies with immediate errors", async () => {
    const nextState = state(false);
    const result = {
      callId: "call-1:research",
      isError: true as const,
      kind: "subagent-result" as const,
      origin: "dispatch" as const,
      output: { code: "AGENT_UNREACHABLE", message: "gone" },
      subagentName: "research",
    };
    vi.mocked(dispatchTaskAgentInvocationStep).mockResolvedValue({
      kind: "failed",
      result,
      sessionState: nextState,
    });

    const routed = await routeDeliverToChildren({
      callbackBaseUrl: "https://parent.example",
      delivery: {
        kind: "deliver",
        payloads: [
          {
            task: {
              agentRequests: [
                {
                  replyTo: "agent-reply",
                  request: {
                    input: { message: "Find it", target: "research" },
                    invocationId: "call-1:research",
                    kind: "agent-invoke" as const,
                  },
                  taskId: "task-1",
                },
              ],
            },
          },
        ],
      },
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: { source: "parent" },
      sessionState: state(false),
    });

    expect(dispatchTaskAgentInvocationStep).toHaveBeenCalledWith({
      callbackBaseUrl: "https://parent.example",
      replyTo: "agent-reply",
      request: {
        input: { message: "Find it", target: "research" },
        invocationId: "call-1:research",
        kind: "agent-invoke",
      },
      serializedContext: { source: "parent" },
      sessionState: state(false),
      taskId: "task-1",
    });
    expect(resumeHookStep).toHaveBeenCalledWith("agent-reply", {
      kind: "runtime-action-result",
      results: [result],
    });
    expect(acceptTaskAuthorizationEventStep).not.toHaveBeenCalled();
    expect(routed).toMatchObject({ sessionState: nextState });
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
