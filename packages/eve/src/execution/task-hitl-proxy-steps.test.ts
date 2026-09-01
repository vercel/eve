import { beforeEach, describe, expect, it, vi } from "vitest";

import { readDurableSession } from "#execution/durable-session-store.js";
import {
  acceptTaskAgentEventStep,
  recordTaskInputRequestStep,
} from "#execution/task-hitl-proxy-steps.js";
import { readLatestTaskView } from "#execution/tasks/parent/run-parent.js";
import { setAgentHandleStore } from "#harness/handles/store.js";
import { getProxyInputRequests } from "#harness/proxy-input-requests.js";

vi.mock("#execution/durable-session-store.js", () => ({ readDurableSession: vi.fn() }));
vi.mock("#execution/tasks/parent/run-parent.js", () => ({ readLatestTaskView: vi.fn() }));
vi.mock("#shared/input.js", () => ({
  isInputRequest: vi.fn(
    (value: unknown) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Reflect.get(value, "kind") === "question" &&
      typeof Reflect.get(value, "requestId") === "string",
  ),
}));

const request = {
  replyTo: "eve:workflow-tool-run-answer:run-1:0",
  request: {
    action: { callId: "call-1", input: {}, kind: "tool-call" as const, toolName: "export" },
    kind: "question" as const,
    prompt: "Continue?",
    requestId: "req-1",
  },
  sequence: 0,
  stepIndex: 2,
  taskId: "task-1",
  turnId: "turn-1",
};

const sessionState = {
  continuationToken: "parent-token",
  emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn-1" },
  hasProxyInputRequests: false,
  sessionId: "parent-session",
  version: 1,
} as const;
const remoteReplyTo = "eve:eve:op:0123456789abcdef0123456789abcdef";
const authorizationEvent = {
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

describe("recordTaskInputRequestStep", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(readDurableSession).mockResolvedValue({
      agent: { system: "" },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent-session",
      state: {
        "eve.tasks": {
          tasks: [
            {
              createdByTurnId: "turn-1",
              metadata: { kind: "tool", name: "export" },
              taskId: "task-1",
              taskInboxToken: "task-token",
              taskRunId: "task-run",
            },
          ],
          version: 2,
        },
      },
    });
  });

  it("records a generic workflow answer route after matching the task view", async () => {
    vi.mocked(readLatestTaskView).mockResolvedValue({
      inputRequests: [request.request],
      metadata: { kind: "tool", name: "export" },
      status: "input_required",
      taskId: "task-1",
    });

    const result = await recordTaskInputRequestStep({ request, sessionState });

    expect(result).toMatchObject({
      accepted: true,
      request: { request: { requestId: "task-1:req-1" } },
      sessionState: { hasProxyInputRequests: true },
    });
    expect(
      getProxyInputRequests(result.sessionState.snapshot?.session.state).get("task-1:req-1"),
    ).toEqual({
      childContinuationToken: request.replyTo,
      childRequestId: "req-1",
      kind: "question",
      taskId: "task-1",
    });
  });

  it("rejects a request that does not match the task's outstanding batch", async () => {
    vi.mocked(readLatestTaskView).mockResolvedValue({
      inputRequests: [{ ...request.request, requestId: "other" }],
      metadata: { kind: "tool", name: "export" },
      status: "input_required",
      taskId: "task-1",
    });

    await expect(recordTaskInputRequestStep({ request, sessionState })).resolves.toEqual({
      accepted: false,
      sessionState,
    });
  });

  it("records a narrowed remote response route for a claimed remote child", async () => {
    vi.mocked(readDurableSession).mockResolvedValue({
      agent: { system: "" },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent-session",
      state: setAgentHandleStore(
        {
          "eve.tasks": {
            tasks: [
              {
                createdByTurnId: "turn-1",
                metadata: { kind: "tool", name: "export" },
                taskId: "task-1",
                taskInboxToken: "task-token",
                taskRunId: "task-run",
              },
            ],
            version: 2,
          },
        },
        {
          handles: [
            {
              address: {
                callbackBaseUrl: "https://parent.example",
                kind: "agent/remote",
                sessionId: "remote-session",
                url: "https://remote.example",
              },
              identity: { id: "agent-1", name: "export", nodeId: "node-1" },
              operationId: "operation-1",
              phase: "claimed",
              taskId: "task-1",
            },
          ],
        },
      ),
    });
    const remoteRequest = {
      ...request,
      replyTo: remoteReplyTo,
      request: { ...request.request, requestId: "remote-req" },
    };
    vi.mocked(readLatestTaskView).mockResolvedValue({
      inputRequests: [remoteRequest.request],
      metadata: { kind: "tool", name: "export" },
      status: "input_required",
      taskId: "task-1",
    });

    const result = await recordTaskInputRequestStep({ request: remoteRequest, sessionState });

    expect(
      getProxyInputRequests(result.sessionState.snapshot?.session.state).get("task-1:remote-req"),
    ).toMatchObject({
      childResponseUrl:
        "https://remote.example/eve/v1/task-input/eve%3Atask-input%3A0123456789abcdef0123456789abcdef",
    });
  });
});

describe("acceptTaskAgentEventStep", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(readDurableSession).mockResolvedValue({
      agent: { system: "" },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent-session",
      state: setAgentHandleStore(
        {
          "eve.tasks": {
            tasks: [
              {
                createdByTurnId: "turn-1",
                metadata: { kind: "tool", name: "export" },
                taskId: "task-1",
                taskInboxToken: "task-token",
                taskRunId: "task-run",
              },
            ],
            version: 2,
          },
        },
        {
          handles: [
            {
              address: {
                callbackBaseUrl: "https://parent.example",
                kind: "agent/remote",
                sessionId: "child-1",
                url: "https://remote.example",
              },
              identity: { id: "agent-1", name: "research", nodeId: "node-1" },
              operationId: "operation-1",
              phase: "claimed",
              taskId: "task-1",
            },
          ],
        },
      ),
    });
    vi.mocked(readLatestTaskView).mockResolvedValue({
      metadata: { kind: "tool", name: "export" },
      status: "working",
      taskId: "task-1",
    });
  });

  it("accepts an authorization event from the task's claimed child agent", async () => {
    await expect(
      acceptTaskAgentEventStep({
        effect: {
          input: authorizationEvent,
          name: "agent.event",
          replyTo: "agent-reply",
          taskId: "task-1",
        },
        sessionState,
      }),
    ).resolves.toEqual({ accepted: true, hookPayload: authorizationEvent });
    expect(readLatestTaskView).toHaveBeenCalledWith({ taskRunId: "task-run" });
  });

  it("accepts the first authorization event while the task child start is still reserved", async () => {
    vi.mocked(readDurableSession).mockResolvedValue({
      agent: { system: "" },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent-session",
      state: setAgentHandleStore(
        {
          "eve.tasks": {
            tasks: [
              {
                createdByTurnId: "turn-1",
                metadata: { kind: "tool", name: "export" },
                taskId: "task-1",
                taskInboxToken: "task-token",
                taskRunId: "task-run",
              },
            ],
            version: 2,
          },
        },
        {
          handles: [
            {
              identity: { id: "agent-1", name: "research", nodeId: "node-1" },
              operationId: "operation-1",
              phase: "reserved",
              taskId: "task-1",
            },
          ],
        },
      ),
    });

    await expect(
      acceptTaskAgentEventStep({
        effect: {
          input: authorizationEvent,
          name: "agent.event",
          replyTo: "agent-reply",
          taskId: "task-1",
        },
        sessionState,
      }),
    ).resolves.toEqual({ accepted: true, hookPayload: authorizationEvent });
  });

  it("rejects an authorization event from a child session not claimed by the task", async () => {
    await expect(
      acceptTaskAgentEventStep({
        effect: {
          input: { ...authorizationEvent, childSessionId: "other-child" },
          name: "agent.event",
          replyTo: "agent-reply",
          taskId: "task-1",
        },
        sessionState,
      }),
    ).resolves.toEqual({ accepted: false });
  });
});
