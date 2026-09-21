import {
  recordWorkflowTaskView,
  getBackgroundWorkflowToolRuns,
} from "#harness/workflow-tool-runs.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextContainer } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import {
  recordTerminalTaskViewsStep,
  recordTaskInputRequestStep,
} from "#execution/tasks/parent/hitl-proxy-steps.js";
import { bindSessionInstrumentation } from "#instrumentation/runtime.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { getAgentRegistryState, setAgentRegistryState } from "#subagents/registry/state.js";
import {
  getProxyInputRequests,
  upsertProxyInputRequestState,
} from "#harness/proxy-input-requests.js";

const flushInstrumentation = vi.hoisted(() => vi.fn());
const publishBackgroundTaskSettlements = vi.hoisted(() => vi.fn());

vi.mock("#execution/durable-session-store.js", async (importOriginal) => ({
  ...(await importOriginal()),
  readDurableSession: vi.fn(),
}));
vi.mock("#instrumentation/runtime.js", () => ({
  bindSessionInstrumentation: vi.fn(),
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));
vi.mock("#shared/input.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#shared/input.js")>()),
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

const sessionState = createTestSessionState({
  continuationToken: "parent-token",
  emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn-1" },
  hasProxyInputRequests: false,
  sessionId: "parent-session",
  version: 1,
});
const remoteReplyTo = "eve:eve:op:0123456789abcdef0123456789abcdef";

describe("recordTaskInputRequestStep", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(readDurableSession).mockReturnValue({
      agent: { system: "" },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent-session",
      state: {
        "eve.workflowTool": {
          version: 3,
          runs: [
            {
              callId: "task-1",
              toolName: "export",
              lifetime: "session" as const,
              origin: { turnId: "turn-1", stepIndex: 0 },
              address: { runId: "task-run", hookToken: "task-token" },
              task: {
                dispatchContext: { auth: { current: null, initiator: null } },
                metadata: { kind: "tool", name: "export" },
                taskId: "task-1",
              },
            },
          ],
        },
      },
    });
  });

  it("records a generic workflow answer route for a parent-owned task", async () => {
    const result = await recordTaskInputRequestStep({ request, sessionState });

    expect(result).toMatchObject({
      accepted: true,
      request: { request: { requestId: "task-1:req-1" } },
      sessionState: { hasProxyInputRequests: true },
    });
    expect(
      getProxyInputRequests(result.sessionState.snapshot.session.state).get("task-1:req-1"),
    ).toEqual({
      childContinuationToken: request.replyTo,
      childRequestId: "req-1",
      kind: "question",
      taskId: "task-1",
    });
  });

  it("rejects a late input request after parent settlement", async () => {
    const session = readDurableSession(sessionState);
    vi.mocked(readDurableSession).mockReturnValue({
      ...session,
      state: recordWorkflowTaskView(session.state, {
        lastOutput: { data: "done", type: "result" },
        metadata: { kind: "tool", name: "export" },
        status: "completed",
        taskId: "task-1",
      }),
    });

    await expect(recordTaskInputRequestStep({ request, sessionState })).resolves.toEqual({
      accepted: false,
      sessionState,
    });
  });

  it("records a narrowed remote response route for a claimed remote child", async () => {
    vi.mocked(readDurableSession).mockReturnValue({
      agent: { system: "" },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent-session",
      state: setAgentRegistryState(
        {
          "eve.workflowTool": {
            version: 3,
            runs: [
              {
                callId: "task-1",
                toolName: "export",
                lifetime: "session" as const,
                origin: { turnId: "turn-1", stepIndex: 0 },
                address: { runId: "task-run", hookToken: "task-token" },
                task: {
                  dispatchContext: { auth: { current: null, initiator: null } },
                  metadata: { kind: "tool", name: "export" },
                  taskId: "task-1",
                },
              },
            ],
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
              ownerId: "task-1",
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

    const result = await recordTaskInputRequestStep({ request: remoteRequest, sessionState });

    expect(
      getProxyInputRequests(result.sessionState.snapshot.session.state).get("task-1:remote-req"),
    ).toMatchObject({
      childResponseUrl:
        "https://remote.example/eve/v1/task-input/eve%3Atask-input%3A0123456789abcdef0123456789abcdef",
    });
  });
});

describe("recordTerminalTaskViewsStep", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(bindSessionInstrumentation).mockReturnValue({
      flush: flushInstrumentation,
      publishBackgroundTaskSettlements,
    } as never);
  });

  it("records an owned outcome and releases its agent lease and input routes", async () => {
    vi.mocked(readDurableSession).mockReturnValue({
      agent: { system: "" },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent-session",
      state: setAgentRegistryState(
        {
          "eve.workflowTool": {
            version: 3,
            runs: [
              {
                callId: "task-1",
                toolName: { agentId: "agent-1", kind: "subagent", mode: "local", name: "research" }
                  .name,
                lifetime: "session" as const,
                origin: { turnId: "turn-1", stepIndex: 0 },
                address: { runId: "task-run", hookToken: "task-token" },
                task: {
                  dispatchContext: { auth: { current: null, initiator: null } },
                  metadata: {
                    agentId: "agent-1",
                    kind: "subagent",
                    mode: "local",
                    name: "research",
                  },
                  taskId: "task-1",
                },
              },
            ],
          },
        },
        {
          handles: [
            {
              address: {
                continuationToken: "child-token",
                kind: "agent/local",
                sessionId: "child-1",
              },
              identity: { id: "agent-1", name: "research", nodeId: "node-1" },
              operationId: "operation-1",
              phase: "claimed",
              ownerId: "task-1",
            },
          ],
        },
      ),
    });
    const view = {
      lastOutput: { data: "done", type: "result" as const },
      metadata: { agentId: "agent-1", kind: "subagent", mode: "local" as const, name: "research" },
      status: "completed" as const,
      taskId: "task-1",
    };

    const current = readDurableSession(sessionState);
    vi.mocked(readDurableSession).mockReturnValue({
      ...current,
      state: upsertProxyInputRequestState({
        state: current.state,
        forChildContinuationToken: "question-hook",
        entries: [
          [
            "task-1:question",
            { childContinuationToken: "question-hook", kind: "question", taskId: "task-1" },
          ],
        ],
      }),
    });
    const result = await recordTerminalTaskViewsStep({
      serializedContext: {},
      sessionState,
      views: [view],
    });
    const state = result.sessionState.snapshot.session.state;

    expect(getBackgroundWorkflowToolRuns(state)[0]?.task.outcome).toEqual({
      status: view.status,
      lastOutput: view.lastOutput,
    });
    expect(getProxyInputRequests(state).size).toBe(0);
    expect(result.sessionState.hasProxyInputRequests).toBe(false);
    expect(getAgentRegistryState(state)?.handles).toEqual([
      expect.objectContaining({ phase: "available" }),
    ]);
    expect(result.serializedContext).toEqual({});
  });

  it("settles instrumentation from an accepted terminal task view", async () => {
    const bundle = {
      compiledArtifactsSource: { kind: "bundled" },
      nodeId: "__root__",
      turnAgent: { id: "parent-agent" },
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);
    const context = new ContextContainer();
    context.set(BundleKey, bundle);
    const serializedContext = serializeContext(context);
    vi.mocked(readDurableSession).mockReturnValue({
      agent: { system: "" },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent-session",
      state: {
        "eve.workflowTool": {
          version: 3,
          runs: [
            {
              callId: "task-1",
              toolName: "export",
              lifetime: "session" as const,
              origin: { turnId: "turn-1", stepIndex: 0 },
              address: { runId: "task-run", hookToken: "task-token" },
              task: {
                dispatchContext: { auth: { current: null, initiator: null } },
                metadata: { kind: "tool", name: "export" },
                taskId: "task-1",
              },
            },
          ],
        },
      },
    });
    const view = {
      lastOutput: { data: "done", type: "result" as const },
      metadata: { kind: "tool", name: "export" },
      status: "completed" as const,
      taskId: "task-1",
    };

    const result = await recordTerminalTaskViewsStep({
      serializedContext,
      sessionState,
      views: [view],
    });

    expect(result.subagentCompletions).toEqual([]);
    expect(bindSessionInstrumentation).toHaveBeenCalledWith({
      agentName: "parent-agent",
      ctx: expect.any(ContextContainer),
      rootSessionId: "parent-session",
      sessionId: "parent-session",
    });
    expect(publishBackgroundTaskSettlements).toHaveBeenCalledWith({
      acceptedAtMs: expect.any(Number),
      views: [view],
    });
    expect(flushInstrumentation).toHaveBeenCalledOnce();
    expect(result.serializedContext).not.toBe(serializedContext);
  });
});
