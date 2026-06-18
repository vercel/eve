import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHook } from "#compiled/@workflow/core/index.js";

import type { HookPayload } from "#channel/types.js";
import { getRuntimeActionRequestKey } from "#runtime/actions/keys.js";
import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { TurnCompletionPayload } from "#execution/turn-workflow.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import {
  dispatchTurnStep,
  routeProxiedDeliverStep,
  runProxyInputRequestStep,
} from "#execution/workflow-steps.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: vi.fn(),
  getWorkflowMetadata: vi.fn(() => ({
    url: "https://eve.example.com",
    workflowRunId: "wrun_test_123",
  })),
  getWritable: vi.fn(
    () =>
      new WritableStream<Uint8Array>({
        write() {},
      }),
  ),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: vi.fn(),
}));

vi.mock("./create-session-step.js", () => ({
  createSessionStep: vi.fn().mockResolvedValue(
    createSessionStepResultForMock(
      createSessionStateForMock({
        continuationToken: "http:test",
        sessionId: "wrun_test_123",
      }),
    ),
  ),
}));

vi.mock("./dispatch-runtime-actions-step.js", () => ({
  dispatchRuntimeActionsStep: vi
    .fn()
    .mockImplementation(async ({ sessionState }: { sessionState: DurableSessionState }) => ({
      results: [],
      sessionState,
    })),
}));

vi.mock("./workflow-steps.js", () => ({
  dispatchTurnStep: vi.fn().mockImplementation(async () => ({ runId: "turn-run" })),
  emitTerminalSessionFailureStep: vi.fn().mockResolvedValue(undefined),
  routeProxiedDeliverStep: vi
    .fn()
    .mockImplementation(async ({ payload }) => ({ remainder: payload })),
  runProxyInputRequestStep: vi
    .fn()
    .mockImplementation(async ({ serializedContext, sessionState }) => ({
      serializedContext,
      sessionState,
    })),
}));

function createSessionStateForMock(
  overrides: Partial<DurableSessionState> = {},
): DurableSessionState {
  return {
    continuationToken: "http:test",
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
    hasProxyInputRequests: false,
    sessionId: "wrun_test_123",
    version: 1,
    ...overrides,
  };
}

function createSessionStepResultForMock(state: DurableSessionState) {
  return {
    identity: { agentId: "test-agent", nodeId: "$root" },
    state,
  };
}

vi.mock("./session-callback-step.js", () => ({
  fireSessionCallbackStep: vi.fn().mockResolvedValue(undefined),
}));

interface ParkHookConfig {
  readonly dispose?: () => void;
  readonly return?: () => Promise<IteratorResult<HookPayload>>;
  readonly token: string;
  readonly values?: readonly HookPayload[];
}

describe("workflowEntry", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    vi.stubEnv("VERCEL_ENV", "");
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("injects the workflow run id as the canonical session id before the first turn", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    installHookMocks({
      turnCompletions: [
        turnResult({
          action: "done",
          output: "ok",
          serializedContext: { "eve.sessionId": "wrun_test_123" },
          sessionState,
        }),
      ],
    });

    const result = await workflowEntry({
      input: { message: "hello there" },
      serializedContext: createSerializedContext(),
    });

    expect(result).toEqual({ output: "ok" });
    expect(createSessionStep).toHaveBeenCalledWith({
      compiledArtifactsSource: {},
      continuationToken: "http:test",
      inputMessage: "hello there",
      nodeId: undefined,
      serializedContext: expect.objectContaining({
        "eve.continuationToken": "http:test",
        "eve.mode": "conversation",
      }),
      sessionId: "wrun_test_123",
    });
    expect(dispatchTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({
        completionToken: expect.any(String),
        delivery: {
          kind: "deliver",
          payloads: [{ message: "hello there", context: undefined }],
        },
        serializedContext: expect.objectContaining({
          "eve.continuationToken": "http:test",
          "eve.mode": "conversation",
          "eve.sessionId": "wrun_test_123",
        }),
        sessionState,
      }),
    );
  });

  it("buffers follow-up user input until a pending subagent batch resolves", async () => {
    const baseSessionState = createBaseSessionState();
    const pendingSessionState = createPendingSubagentSessionState("forecast_delegate");
    const resumedSessionState: DurableSessionState = {
      ...baseSessionState,
    };

    vi.mocked(createSessionStep).mockResolvedValue(
      createSessionStepResultForMock(baseSessionState),
    );
    installHookMocks({
      parkHooks: [
        {
          token: "http:test",
          values: [
            {
              kind: "deliver",
              payloads: [{ message: "follow up while child runs" }],
            },
            {
              kind: "runtime-action-result",
              results: [
                {
                  callId: "call-1",
                  kind: "subagent-result",
                  output: "delegated output",
                  subagentName: "forecast_delegate",
                },
              ],
            },
          ],
        },
      ],
      turnCompletions: [
        turnResult({
          action: "dispatch-runtime-actions",
          pendingActionKeys: subagentPendingActionKeys("forecast_delegate"),
          sessionState: pendingSessionState,
        }),
        turnResult({ action: "park", sessionState: resumedSessionState }),
        turnResult({
          action: "done",
          output: "after follow-up",
          sessionState: resumedSessionState,
        }),
      ],
    });

    const result = await workflowEntry({
      input: { message: "hello there" },
      serializedContext: createSerializedContext(),
    });

    expect(result).toEqual({ output: "after follow-up" });
    expect(turnCompletionTokens()).toEqual([
      "wrun_test_123:turn-completion:0",
      "wrun_test_123:turn-completion:1",
      "wrun_test_123:turn-completion:2",
    ]);
    const parentWritable = vi.mocked(dispatchTurnStep).mock.calls[0]?.[0].parentWritable;
    expect(dispatchRuntimeActionsStep).toHaveBeenCalledWith({
      callbackBaseUrl: "https://eve.example.com",
      parentWritable,
      serializedContext: expect.objectContaining({
        "eve.sessionId": "wrun_test_123",
      }),
      sessionState: pendingSessionState,
    });
    expect(vi.mocked(dispatchTurnStep).mock.calls[1]?.[0].delivery).toEqual({
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-1",
          kind: "subagent-result",
          output: "delegated output",
          subagentName: "forecast_delegate",
        },
      ],
    });
    expect(vi.mocked(dispatchTurnStep).mock.calls[2]?.[0].delivery).toEqual({
      kind: "deliver",
      payloads: [{ message: "follow up while child runs" }],
    });
  });

  it("feeds immediate remote dispatch failures back into the parent turn", async () => {
    const baseSessionState = createBaseSessionState();
    const pendingSessionState = createPendingRemoteAgentSessionState("research");
    const resumedSessionState: DurableSessionState = {
      ...baseSessionState,
    };
    const failedResult = {
      callId: "call-1",
      isError: true,
      kind: "subagent-result",
      output: {
        code: "REMOTE_AGENT_START_FAILED",
        message: "remote unavailable",
      },
      subagentName: "research",
    } satisfies RuntimeSubagentResultActionResult;

    vi.mocked(createSessionStep).mockResolvedValue(
      createSessionStepResultForMock(baseSessionState),
    );
    vi.mocked(dispatchRuntimeActionsStep).mockResolvedValueOnce({
      results: [failedResult],
      sessionState: pendingSessionState,
    });
    installHookMocks({
      parkHooks: [
        {
          token: "http:test",
          values: [],
        },
      ],
      turnCompletions: [
        turnResult({
          action: "dispatch-runtime-actions",
          pendingActionKeys: remoteAgentPendingActionKeys("research"),
          sessionState: pendingSessionState,
        }),
        turnResult({
          action: "done",
          output: "handled failure",
          sessionState: resumedSessionState,
        }),
      ],
    });

    const result = await workflowEntry({
      input: { message: "hello there" },
      serializedContext: createSerializedContext(),
    });

    expect(result).toEqual({ output: "handled failure" });
    expect(vi.mocked(dispatchTurnStep).mock.calls[1]?.[0].delivery).toEqual({
      kind: "runtime-action-result",
      results: [failedResult],
    });
  });

  it("proxies a subagent input request through the parent writable while waiting for subagent results", async () => {
    const baseSessionState = createBaseSessionState();
    const pendingSessionState = createPendingSubagentSessionState("linear");
    const resumedSessionState: DurableSessionState = {
      ...baseSessionState,
    };

    vi.mocked(createSessionStep).mockResolvedValue(
      createSessionStepResultForMock(baseSessionState),
    );
    installHookMocks({
      parkHooks: [
        {
          token: "http:test",
          values: [
            createSubagentInputRequest(),
            {
              kind: "runtime-action-result",
              results: [
                {
                  callId: "call-1",
                  kind: "subagent-result",
                  output: "child done",
                  subagentName: "linear",
                },
              ],
            },
          ],
        },
      ],
      turnCompletions: [
        turnResult({
          action: "dispatch-runtime-actions",
          pendingActionKeys: subagentPendingActionKeys("linear"),
          sessionState: pendingSessionState,
        }),
        turnResult({ action: "done", output: "all done", sessionState: resumedSessionState }),
      ],
    });

    const result = await workflowEntry({
      input: { message: "hi" },
      serializedContext: createSerializedContext({
        "eve.capabilities": { requestInput: true },
      }),
    });

    expect(result).toEqual({ output: "all done" });
    expect(runProxyInputRequestStep).toHaveBeenCalledTimes(1);
    const parentWritable = vi.mocked(dispatchTurnStep).mock.calls[0]?.[0].parentWritable;
    const proxyCall = vi.mocked(runProxyInputRequestStep).mock.calls[0]?.[0];
    expect(proxyCall?.parentWritable).toBe(parentWritable);
    expect(proxyCall?.hookPayload.callId).toBe("call-1");
    expect(proxyCall?.hookPayload.childContinuationToken).toBe("subagent:wrun_test_123:call-1");
    expect(proxyCall?.hookPayload.event.requests[0]?.requestId).toBe("req-1");
    expect(vi.mocked(dispatchTurnStep).mock.calls[1]?.[0].delivery).toEqual({
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-1",
          kind: "subagent-result",
          output: "child done",
          subagentName: "linear",
        },
      ],
    });
    expect(routeProxiedDeliverStep).not.toHaveBeenCalled();
  });

  it("rekeys the active hook when proxied subagent input anchors the parent session", async () => {
    const baseSessionState = createBaseSessionState({ continuationToken: "slack:C01:" });
    const pendingSessionState = createPendingSubagentSessionState("linear", {
      continuationToken: "slack:C01:",
    });
    const anchoredSessionState: DurableSessionState = {
      ...pendingSessionState,
      continuationToken: "slack:C01:1800000000.123456",
    };
    const resumedSessionState: DurableSessionState = {
      ...baseSessionState,
      continuationToken: "slack:C01:1800000000.123456",
    };

    vi.mocked(createSessionStep).mockResolvedValue(
      createSessionStepResultForMock(baseSessionState),
    );
    vi.mocked(runProxyInputRequestStep).mockResolvedValueOnce({
      serializedContext: {
        "eve.continuationToken": "slack:C01:1800000000.123456",
        "eve.sessionId": "wrun_test_123",
      },
      sessionState: anchoredSessionState,
    });

    const oldReturn = createIteratorReturn();
    const oldDispose = vi.fn();
    const newReturn = createIteratorReturn();
    const newDispose = vi.fn();

    installHookMocks({
      parkHooks: [
        {
          dispose: oldDispose,
          return: oldReturn,
          token: "slack:C01:",
          values: [createSubagentInputRequest()],
        },
        {
          dispose: newDispose,
          return: newReturn,
          token: "slack:C01:1800000000.123456",
          values: [
            {
              kind: "runtime-action-result",
              results: [
                {
                  callId: "call-1",
                  kind: "subagent-result",
                  output: "child done",
                  subagentName: "linear",
                },
              ],
            },
          ],
        },
      ],
      turnCompletions: [
        turnResult({
          action: "dispatch-runtime-actions",
          pendingActionKeys: subagentPendingActionKeys("linear"),
          sessionState: pendingSessionState,
        }),
        turnResult({
          action: "done",
          output: "done after rekey",
          sessionState: resumedSessionState,
        }),
      ],
    });

    const result = await workflowEntry({
      input: { message: "hi" },
      serializedContext: createSerializedContext({
        "eve.capabilities": { requestInput: true },
        "eve.channel": { kind: "slack", state: {} },
        "eve.continuationToken": "slack:C01:",
      }),
    });

    expect(result).toEqual({ output: "done after rekey" });
    expect(nonTurnHookTokens()).toEqual(["slack:C01:", "slack:C01:1800000000.123456"]);
    expect(vi.mocked(dispatchTurnStep).mock.calls[1]?.[0].delivery).toEqual({
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-1",
          kind: "subagent-result",
          output: "child done",
          subagentName: "linear",
        },
      ],
    });
    expect(oldReturn).toHaveBeenCalledTimes(1);
    expect(oldDispose).toHaveBeenCalledTimes(1);
    expect(newReturn).toHaveBeenCalledTimes(1);
    expect(newDispose).toHaveBeenCalledTimes(1);
  });

  it("routes mid-wait HITL responses down to the child instead of buffering them", async () => {
    const baseSessionState = createBaseSessionState();
    const pendingSessionState = createPendingSubagentSessionState("linear");
    const resumedSessionState: DurableSessionState = {
      ...baseSessionState,
    };
    const userResponse = [{ optionId: "approve", requestId: "req-1", text: undefined }];

    vi.mocked(createSessionStep).mockResolvedValue(
      createSessionStepResultForMock(baseSessionState),
    );
    vi.mocked(runProxyInputRequestStep).mockImplementation(
      async ({ serializedContext, sessionState }) => ({
        serializedContext,
        sessionState: {
          ...sessionState,
          hasProxyInputRequests: true,
        },
      }),
    );
    vi.mocked(routeProxiedDeliverStep).mockResolvedValueOnce({ remainder: undefined });

    installHookMocks({
      parkHooks: [
        {
          token: "http:test",
          values: [
            createSubagentInputRequest(),
            {
              auth: null,
              kind: "deliver",
              payloads: [{ inputResponses: userResponse }],
            },
            {
              kind: "runtime-action-result",
              results: [
                {
                  callId: "call-1",
                  kind: "subagent-result",
                  output: "child done",
                  subagentName: "linear",
                },
              ],
            },
          ],
        },
      ],
      turnCompletions: [
        turnResult({
          action: "dispatch-runtime-actions",
          pendingActionKeys: subagentPendingActionKeys("linear"),
          sessionState: pendingSessionState,
        }),
        turnResult({
          action: "done",
          output: "finished after hitl",
          sessionState: resumedSessionState,
        }),
      ],
    });

    const result = await workflowEntry({
      input: { message: "hi" },
      serializedContext: createSerializedContext({
        "eve.capabilities": { requestInput: true },
      }),
    });

    expect(result).toEqual({ output: "finished after hitl" });
    expect(routeProxiedDeliverStep).toHaveBeenCalledTimes(1);
    const routedCall = vi.mocked(routeProxiedDeliverStep).mock.calls[0]?.[0];
    expect(routedCall?.payload).toEqual({ inputResponses: userResponse });
    expect(vi.mocked(dispatchTurnStep).mock.calls[1]?.[0].delivery).toEqual({
      kind: "runtime-action-result",
      results: [
        {
          callId: "call-1",
          kind: "subagent-result",
          output: "child done",
          subagentName: "linear",
        },
      ],
    });
  });

  it("skips the routing step when there are no proxy input requests on the session", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));
    installHookMocks({
      turnCompletions: [
        turnResult({
          action: "done",
          output: "ok",
          serializedContext: { "eve.sessionId": "wrun_test_123" },
          sessionState,
        }),
      ],
    });

    const result = await workflowEntry({
      input: { message: "hello" },
      serializedContext: createSerializedContext(),
    });

    expect(result).toEqual({ output: "ok" });
    expect(routeProxiedDeliverStep).not.toHaveBeenCalled();
  });

  it("parks the first hook under the re-keyed continuation token", async () => {
    const baseSessionState = createBaseSessionState({ continuationToken: "slack:C01:" });
    const rekeyedSessionState: DurableSessionState = {
      ...baseSessionState,
      continuationToken: "slack:C01:1800000000.123456",
    };

    vi.mocked(createSessionStep).mockResolvedValue(
      createSessionStepResultForMock(baseSessionState),
    );

    const initialReturn = createIteratorReturn();
    const initialDispose = vi.fn();
    const rekeyedReturn = createIteratorReturn();
    const rekeyedDispose = vi.fn();
    installHookMocks({
      parkHooks: [
        {
          dispose: initialDispose,
          return: initialReturn,
          token: "slack:C01:",
          values: [],
        },
        {
          dispose: rekeyedDispose,
          return: rekeyedReturn,
          token: "slack:C01:1800000000.123456",
          values: [],
        },
      ],
      turnCompletions: [turnResult({ action: "park", sessionState: rekeyedSessionState })],
    });

    const result = await workflowEntry({
      input: { message: "hello" },
      serializedContext: createSerializedContext({
        "eve.channel": { kind: "slack", state: {} },
        "eve.continuationToken": "slack:C01:",
      }),
    });

    expect(result).toEqual({ output: "" });
    // Initial hook created before the turn, then rekeyed after.
    expect(nonTurnHookTokens()).toEqual(["slack:C01:", "slack:C01:1800000000.123456"]);
    expect(initialReturn).toHaveBeenCalledTimes(1);
    expect(initialDispose).toHaveBeenCalledTimes(1);
    expect(rekeyedReturn).toHaveBeenCalledTimes(1);
    expect(rekeyedDispose).toHaveBeenCalledTimes(1);
  });

  it("defers the first park hook until an empty continuation token is anchored", async () => {
    const baseSessionState = createBaseSessionState({ continuationToken: "" });
    const anchoredSessionState: DurableSessionState = {
      ...baseSessionState,
      continuationToken: "slack:C01:1800000000.123456",
    };

    vi.mocked(createSessionStep).mockResolvedValue(
      createSessionStepResultForMock(baseSessionState),
    );

    const anchoredReturn = createIteratorReturn();
    const anchoredDispose = vi.fn();
    installHookMocks({
      parkHooks: [
        {
          dispose: anchoredDispose,
          return: anchoredReturn,
          token: "slack:C01:1800000000.123456",
          values: [],
        },
      ],
      turnCompletions: [turnResult({ action: "park", sessionState: anchoredSessionState })],
    });

    const result = await workflowEntry({
      input: { message: "hello" },
      serializedContext: createSerializedContext({
        "eve.channel": { kind: "slack", state: {} },
        "eve.continuationToken": "",
      }),
    });

    expect(result).toEqual({ output: "" });
    expect(nonTurnHookTokens()).toEqual(["slack:C01:1800000000.123456"]);
    expect(anchoredReturn).toHaveBeenCalledTimes(1);
    expect(anchoredDispose).toHaveBeenCalledTimes(1);
  });

  it("recreates the park hook when a later turn re-keys the session", async () => {
    const baseSessionState = createBaseSessionState({ continuationToken: "slack:C01:" });
    const rekeyedSessionState: DurableSessionState = {
      ...baseSessionState,
      continuationToken: "slack:C01:1800000000.123456",
    };

    vi.mocked(createSessionStep).mockResolvedValue(
      createSessionStepResultForMock(baseSessionState),
    );

    const oldReturn = createIteratorReturn();
    const oldDispose = vi.fn();
    const newReturn = createIteratorReturn();
    const newDispose = vi.fn();
    installHookMocks({
      parkHooks: [
        {
          dispose: oldDispose,
          return: oldReturn,
          token: "slack:C01:",
          values: [
            {
              kind: "deliver",
              payloads: [{ message: "follow up" }],
            },
          ],
        },
        {
          dispose: newDispose,
          return: newReturn,
          token: "slack:C01:1800000000.123456",
          values: [],
        },
      ],
      turnCompletions: [
        turnResult({ action: "park", sessionState: baseSessionState }),
        turnResult({ action: "park", sessionState: rekeyedSessionState }),
      ],
    });

    const result = await workflowEntry({
      input: { message: "hello" },
      serializedContext: createSerializedContext({
        "eve.channel": { kind: "slack", state: {} },
        "eve.continuationToken": "slack:C01:",
      }),
    });

    expect(result).toEqual({ output: "" });
    expect(nonTurnHookTokens()).toEqual(["slack:C01:", "slack:C01:1800000000.123456"]);
    expect(vi.mocked(dispatchTurnStep).mock.calls[1]?.[0].delivery).toEqual({
      kind: "deliver",
      payloads: [{ message: "follow up" }],
    });
    expect(oldReturn).toHaveBeenCalledTimes(1);
    expect(oldDispose).toHaveBeenCalledTimes(1);
    expect(newReturn).toHaveBeenCalledTimes(1);
    expect(newDispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the workflow hook after the loop exits", async () => {
    const sessionState = createBaseSessionState();
    vi.mocked(createSessionStep).mockResolvedValue(createSessionStepResultForMock(sessionState));

    const dispose = vi.fn();
    const symbolDispose = vi.fn();
    const returnIterator = createIteratorReturn();
    installHookMocks({
      parkHooks: [
        {
          dispose,
          return: returnIterator,
          token: "http:test",
          values: [
            {
              kind: "deliver",
              payloads: [{ message: "follow up" }],
            },
          ],
        },
      ],
      symbolDispose,
      turnCompletions: [
        turnResult({ action: "park", sessionState }),
        turnResult({ action: "done", output: "after resume", sessionState }),
      ],
    });

    const result = await workflowEntry({
      input: { message: "hello there" },
      serializedContext: createSerializedContext(),
    });

    expect(result).toEqual({ output: "after resume" });
    expect(returnIterator).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(symbolDispose).not.toHaveBeenCalled();
  });
});

function createSerializedContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "eve.auth": null,
    "eve.bundle": { source: {} },
    "eve.channel": { kind: "http", state: {} },
    "eve.continuationToken": "http:test",
    "eve.mode": "conversation",
    ...overrides,
  };
}

function createBaseSessionState(overrides: Partial<DurableSessionState> = {}): DurableSessionState {
  return {
    continuationToken: "http:test",
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
    hasProxyInputRequests: false,
    sessionId: "wrun_test_123",
    version: 1,
    ...overrides,
  };
}

function createPendingSubagentSessionState(
  _subagentName: string,
  overrides: Partial<DurableSessionState> = {},
): DurableSessionState {
  return createBaseSessionState(overrides);
}

function createPendingRemoteAgentSessionState(
  _remoteAgentName: string,
  overrides: Partial<DurableSessionState> = {},
): DurableSessionState {
  return createBaseSessionState(overrides);
}

function subagentPendingActionKeys(subagentName: string): readonly string[] {
  return [
    getRuntimeActionRequestKey({
      callId: "call-1",
      description: "Delegate the work.",
      input: { topic: subagentName },
      kind: "subagent-call",
      name: subagentName,
      nodeId: `subagents/${subagentName}`,
      subagentName,
    }),
  ];
}

function remoteAgentPendingActionKeys(remoteAgentName: string): readonly string[] {
  return [
    getRuntimeActionRequestKey({
      callId: "call-1",
      description: "Delegate the work.",
      input: { topic: remoteAgentName },
      kind: "remote-agent-call",
      name: remoteAgentName,
      nodeId: `remote/${remoteAgentName}`,
      remoteAgentName,
    }),
  ];
}

function createSubagentInputRequest(): HookPayload {
  return {
    callId: "call-1",
    childContinuationToken: "subagent:wrun_test_123:call-1",
    childSessionId: "child-session",
    event: {
      requests: [
        {
          action: {
            callId: "tool-call-1",
            input: {},
            kind: "tool-call",
            toolName: "dangerous_tool",
          },
          options: [
            { id: "approve", label: "Approve" },
            { id: "deny", label: "Deny" },
          ],
          prompt: "Approve?",
          requestId: "req-1",
        },
      ],
      sequence: 0,
      stepIndex: 0,
      turnId: "child-turn",
    },
    kind: "subagent-input-request",
    subagentName: "linear",
  };
}

function turnResult(input: {
  readonly action: "done" | "park" | "dispatch-runtime-actions";
  readonly output?: string;
  readonly pendingActionKeys?: readonly string[];
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): TurnCompletionPayload {
  const serializedContext = input.serializedContext ?? { "eve.sessionId": "wrun_test_123" };
  if (input.action === "done") {
    return {
      action: {
        kind: "done",
        output: input.output ?? "",
        serializedContext,
        sessionState: input.sessionState,
      },
      kind: "turn-result",
    };
  }
  if (input.action === "dispatch-runtime-actions") {
    return {
      action: {
        kind: "dispatch-runtime-actions",
        pendingActionKeys: input.pendingActionKeys ?? [],
        serializedContext,
        sessionState: input.sessionState,
      },
      kind: "turn-result",
    };
  }
  return {
    action: {
      kind: "park",
      serializedContext,
      sessionState: input.sessionState,
    },
    kind: "turn-result",
  };
}

function installHookMocks(input: {
  readonly parkHooks?: readonly ParkHookConfig[];
  readonly symbolDispose?: () => void;
  readonly turnCompletions: readonly TurnCompletionPayload[];
}): void {
  const turnCompletions = [...input.turnCompletions];
  const parkHooks = [...(input.parkHooks ?? [])];

  vi.mocked(createHook).mockImplementation((options?: { readonly token?: string }) => {
    const token = options?.token;

    if (token === undefined || isTurnCompletionToken(token)) {
      const value = turnCompletions.shift();
      return createMockHook({
        token: token ?? "turn-completion",
        values: value === undefined ? [] : [value],
      }) as never;
    }

    if (token.endsWith(":auth")) {
      return createMockHook({ token, values: [] }) as never;
    }

    const config = parkHooks.shift() ?? { token, values: [] };
    if (config.token !== token) {
      throw new Error(`Expected park hook token "${config.token}", received "${token}".`);
    }

    return createMockHook({
      dispose: config.dispose,
      return: config.return,
      symbolDispose: input.symbolDispose,
      token,
      values: config.values ?? [],
    }) as never;
  });
}

function createMockHook<T>(input: {
  readonly dispose?: () => void;
  readonly next?: () => Promise<IteratorResult<T>>;
  readonly return?: () => Promise<IteratorResult<T>>;
  readonly symbolDispose?: () => void;
  readonly token: string;
  readonly values: readonly T[];
}): unknown {
  const values = [...input.values];
  const dispose = input.dispose ?? vi.fn();
  const symbolDispose = input.symbolDispose ?? vi.fn();
  const iteratorReturn = input.return;

  return Object.assign(Promise.resolve(undefined), {
    [Symbol.asyncIterator]() {
      return {
        next:
          input.next ??
          async function next(): Promise<IteratorResult<T>> {
            const value = values.shift();
            if (value === undefined) {
              return { done: true, value: undefined };
            }
            return { done: false, value };
          },
        return: iteratorReturn,
      };
    },
    [Symbol.dispose]: symbolDispose,
    dispose,
    token: input.token,
  });
}

function createIteratorReturn(): () => Promise<IteratorResult<HookPayload>> {
  return vi.fn(
    async (): Promise<IteratorResult<HookPayload>> => ({
      done: true,
      value: undefined,
    }),
  );
}

function nonTurnHookTokens(): string[] {
  return vi
    .mocked(createHook)
    .mock.calls.map((call) => call[0]?.token)
    .filter(
      (token): token is string =>
        token !== undefined && !token.endsWith(":auth") && !isTurnCompletionToken(token),
    );
}

function turnCompletionTokens(): string[] {
  return vi
    .mocked(createHook)
    .mock.calls.map((call) => call[0]?.token)
    .filter((token): token is string => token !== undefined && isTurnCompletionToken(token));
}

function isTurnCompletionToken(token: string): boolean {
  return /:turn-completion:\d+$/.test(token);
}
